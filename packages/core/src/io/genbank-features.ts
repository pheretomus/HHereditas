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

/** Warning about an unindented line of the feature table that was not used. */
function warnIgnoredUnindented(body: BodyLine, warn: WarnFn): void {
  warn(`unindented line '${body.text.slice(0, 40)}' in the feature table was ignored`, body.line);
}

/**
 * Read the feature table between `start` (first line after the FEATURES header) and `end`
 * (exclusive). Lines are already free of trailing blanks.
 *
 * A non-blank line starting in column 1 is not part of the table layout (keys start in column
 * 6, everything else in column 22); only qualifier lines ('/') are accepted there. Such a line is
 * read as the continuation of an unfinished location or quoted value, which is what a raw line
 * break inside a value produces. Otherwise it is a feature key line that lost its indent when
 * it looks like one (see {@link columnOneKeyLine}): it starts a new feature, so that the
 * qualifiers after it are not attached to the previous feature. Any other such line is ignored.
 * All three cases come with a warning. A stray line never ends the table, so it cannot drop the
 * features after it (Biopython 1.88 likewise skips such a line when it is shorter than 21
 * characters, "line too short to contain a feature").
 */
export function readFeatureTable(lines: readonly string[], start: number, end: number, warn: WarnFn): RawFeature[] {
  const features: RawFeature[] = [];
  let block: FeatureBlock | undefined;
  const flush = () => {
    // A feature's body can hold further features whose key lines start in column 1.
    for (let b = block; b !== undefined; ) {
      const built = buildRawFeature(b, warn);
      features.push(built.feature);
      b = built.next;
    }
  };
  for (let i = start; i < end; i++) {
    const raw = lines[i];
    if (raw === '') continue;
    const indent = indentation(raw);
    const text = raw.slice(indent);
    if (indent === 0 && text[0] !== '/') {
      const stray: BodyLine = { text, line: i + 1, unindented: true };
      if (block !== undefined) block.body.push(stray);
      else {
        const body = [stray];
        const head = columnOneKeyLine(body, 0);
        if (head === undefined) warnIgnoredUnindented(stray, warn);
        else block = columnOneBlock(head, body, 0, warn);
      }
      continue;
    }
    if (indent > MAX_KEY_INDENT || text[0] === '/') {
      if (block === undefined) warn('text before the first feature key was ignored', i + 1);
      else block.body.push({ text, line: i + 1 });
      continue;
    }
    flush();
    const space = text.search(/\s/);
    const rest = space < 0 ? '' : text.slice(space).trim();
    block = { key: space < 0 ? text : text.slice(0, space), line: i + 1, body: rest === '' ? [] : [{ text: rest, line: i + 1 }], start: 0 };
  }
  flush();
  return features;
}

interface BodyLine {
  text: string;
  line: number;
  /** The line starts in column 1 (see {@link readFeatureTable}). */
  unindented?: true;
}

/**
 * A feature key, the 1-based line of its key line, and its location and qualifier lines
 * `body[start..]`. Features split off at column-1 key lines share the body array of the block
 * they were found in (no copies: reading stays linear in the number of lines).
 */
interface FeatureBlock {
  key: string;
  line: number;
  body: BodyLine[];
  start: number;
}

/**
 * Feature keys recognised on a key line that starts in column 1 (see {@link columnOneKeyLine}).
 * Sources: INSDC Feature Table Definition 11.4 (April 2026), section 7.2 "Appendix II: Feature
 * keys reference"; the keys merged into `regulatory` in December 2014 (DDBJ "Feature key" page,
 * https://www.ddbj.nig.ac.jp/ddbj/features-e.html), which plasmid files still use; the older
 * keys of WIPO ST.25 (37 CFR 1.822, Appendix E to Subpart G of Part 1).
 */
const KNOWN_FEATURE_KEYS: ReadonlySet<string> = new Set([
  // INSDC 11.4, section 7.2
  'assembly_gap', 'C_region', 'CDS', 'centromere', 'D-loop', 'D_segment', 'exon', 'gap', 'gene', 'iDNA',
  'intron', 'J_segment', 'mat_peptide', 'misc_binding', 'misc_difference', 'misc_feature', 'misc_recomb',
  'misc_RNA', 'misc_structure', 'mobile_element', 'modified_base', 'mRNA', 'ncRNA', 'N_region',
  'old_sequence', 'operon', 'oriT', 'polyA_site', 'precursor_RNA', 'prim_transcript', 'primer_bind',
  'propeptide', 'protein_bind', 'regulatory', 'repeat_region', 'rep_origin', 'rRNA', 'S_region',
  'sig_peptide', 'source', 'stem_loop', 'STS', 'telomere', 'tmRNA', 'transit_peptide', 'tRNA', 'unsure',
  'V_region', 'V_segment', 'variation', "3'UTR", "5'UTR",
  // merged into regulatory + /regulatory_class (DDBJ, December 2014)
  'attenuator', 'CAAT_signal', 'enhancer', 'GC_signal', '-35_signal', '-10_signal', 'polyA_signal',
  'promoter', 'RBS', 'TATA_signal', 'terminator', 'misc_signal',
  // WIPO ST.25 (37 CFR 1.822, Appendix E)
  'allele', 'conflict', 'LTR', 'mutation', 'repeat_unit', 'satellite', 'scRNA', 'snRNA', "3'clip", "5'clip",
]);

/** A feature key (INSDC key characters), then optionally blanks and one more token. */
const COLUMN_ONE_KEY_LINE = /^([A-Za-z0-9_'*-]*[A-Za-z][A-Za-z0-9_'*-]*)(?:([ \t]+)(\S+))?$/;

/**
 * The key and location text of `lines[at]`, an unindented line, when it is a feature key line
 * that lost its 5-blank indent: a known feature key (see {@link KNOWN_FEATURE_KEYS}) followed by
 * location text, or alone when the next line is an indented location line; or any key followed
 * by location text in the standard layout (location from column 17, i.e. column 22 without the
 * indent). Free text never qualifies: two words of which the second is no location, a
 * sentence, an unknown word alone. Undefined otherwise.
 */
function columnOneKeyLine(lines: readonly BodyLine[], at: number): { key: string; location: string } | undefined {
  const m = COLUMN_ONE_KEY_LINE.exec(lines[at].text);
  if (m === null) return undefined;
  const [, key, gap, location] = m;
  if (location === undefined) {
    const next = lines[at + 1];
    const locationFollows = next !== undefined && next.unindented !== true && next.text[0] !== '/' && looksLikeLocationText(next.text);
    return KNOWN_FEATURE_KEYS.has(key) && locationFollows ? { key, location: '' } : undefined;
  }
  if (!looksLikeLocationText(location)) return undefined;
  const standardLayout = /^ +$/.test(gap) && (key.length + gap.length === 16 || (key.length >= 16 && gap.length === 1));
  return KNOWN_FEATURE_KEYS.has(key) || standardLayout ? { key, location } : undefined;
}

/**
 * The feature block that starts at the column-1 key line `lines[at]` (with a warning). The key
 * line's entry is replaced by its location text, which becomes the block's first body line;
 * `lines` is a body array owned by the reader, and nothing reads that entry afterwards.
 */
function columnOneBlock(head: { key: string; location: string }, lines: BodyLine[], at: number, warn: WarnFn): FeatureBlock {
  const keyLine = lines[at];
  warn(`feature key line '${keyLine.text.slice(0, 40)}' starts in column 1 instead of column 6: read as a new feature`, keyLine.line);
  if (head.location === '') return { key: head.key, line: keyLine.line, body: lines, start: at + 1 };
  lines[at] = { text: head.location, line: keyLine.line };
  return { key: head.key, line: keyLine.line, body: lines, start: at };
}

/** Characters that can continue a location broken across lines (digits, range syntax). */
const LOCATION_CONTINUATION = /^[0-9<>.^,)(:]/;
/** Text made only of location characters (operators, accessions, numbers, range syntax). */
const LOCATION_CHARACTERS = /^[\w.|:<>^,()-]+$/;

/**
 * True when an unindented line can be the rest of an unfinished location: location characters
 * only, with at least one base number. Anything else is a stray line, which must not make the
 * whole location unreadable.
 */
function looksLikeLocationText(text: string): boolean {
  return LOCATION_CHARACTERS.test(text) && /\d/.test(text);
}

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

/**
 * The raw feature of one block, and the block of the next feature when the body holds a
 * feature key line that starts in column 1 (see {@link readFeatureTable}).
 */
function buildRawFeature(block: FeatureBlock, warn: WarnFn): { feature: RawFeature; next?: FeatureBlock } {
  const { key, line, body, start } = block;
  // The location continues while it is unfinished: empty, ending with a comma, unbalanced
  // parentheses, or followed by a line that can only be location text (a number broken
  // across lines, a closing parenthesis). Only the latest line is inspected and the lines are
  // joined once at the end: testing the growing concatenation after every line (`endsWith`)
  // flattens it each time, which made locations written over many lines quadratic to read.
  // Body lines are never empty and carry no trailing blanks, so the location ends with ','
  // exactly when its latest line does. An unindented line only continues a location that has
  // started, is visibly unfinished and that it can continue; otherwise it is skipped (inside the
  // location) or left to the loop below (after it).
  let k = start;
  const parts: string[] = [];
  let endsWithComma = false;
  let balance = 0;
  const locationText = () => parts.join('').replace(/\s+/g, '');
  while (k < body.length && body[k].text[0] !== '/') {
    const next = body[k].text;
    const open = endsWithComma || balance > 0;
    if (body[k].unindented) {
      if (parts.length === 0 || !open) break;
      if (!looksLikeLocationText(next)) {
        // Inside an unfinished location only an unambiguous `key location` line is a key line.
        const head = columnOneKeyLine(body, k);
        if (head !== undefined && head.location !== '') {
          return { feature: { key, line, locationText: locationText(), qualifiers: [] }, next: columnOneBlock(head, body, k, warn) };
        }
        warnIgnoredUnindented(body[k], warn);
        k++;
        continue;
      }
      warn(`unindented line '${next.slice(0, 40)}' read as part of the location of feature '${key}'`, body[k].line);
    } else if (parts.length > 0 && !open && !LOCATION_CONTINUATION.test(next)) {
      break;
    }
    parts.push(next);
    endsWithComma = next.endsWith(',');
    balance += parenBalance(next);
    k++;
  }
  let unexpected = false;
  for (; k < body.length && body[k].text[0] !== '/'; k++) {
    if (body[k].unindented) {
      const head = columnOneKeyLine(body, k);
      if (head !== undefined) return { feature: { key, line, locationText: locationText(), qualifiers: [] }, next: columnOneBlock(head, body, k, warn) };
      warnIgnoredUnindented(body[k], warn);
    } else if (!unexpected) {
      unexpected = true;
      warn(`unexpected text after the location of feature '${key}' was ignored`, body[k].line);
    }
  }
  const { qualifiers, next } = readQualifiers(body, k, key, warn);
  return { feature: { key, line, locationText: locationText(), qualifiers }, next };
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
 * starts a new qualifier or is a feature key line in column 1 (malformed escaping, read like
 * Biopython, which ends a value at any line ending with a quote). Lines that do not start
 * with '/' after a closed value are appended to it (Biopython's "unquoted continuation"),
 * except unindented lines (see {@link readFeatureTable}): they are only read inside an open
 * quoted value; elsewhere a feature key line that lost its indent ends the qualifiers and
 * starts the next feature (`next`), and any other one is ignored; with a warning in each case.
 */
function readQualifiers(lines: BodyLine[], from: number, featureKey: string, warn: WarnFn): { qualifiers: Qualifier[]; next?: FeatureBlock } {
  const raws: RawQualifier[] = [];
  const finish = () => raws.map((r) => finishQualifier(r, warn));
  let i = from;
  while (i < lines.length) {
    const current = lines[i++];
    const { text, line } = current;
    if (text[0] !== '/') {
      const prev = raws[raws.length - 1];
      if (current.unindented) {
        const head = columnOneKeyLine(lines, i - 1);
        if (head !== undefined) return { qualifiers: finish(), next: columnOneBlock(head, lines, i - 1, warn) };
        warnIgnoredUnindented(current, warn);
      } else if (prev !== undefined && prev.parts !== null) prev.parts.push(text);
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
        // Malformed escaping: a line ending with '"' ends the value when a new qualifier or a new
        // feature (key line in column 1) follows.
        if (last.endsWith('"') && (lines[i].text[0] === '/' || (lines[i].unindented === true && columnOneKeyLine(lines, i) !== undefined))) break;
        if (lines[i].unindented) {
          warn(`unindented line '${lines[i].text.slice(0, 40)}' read as part of the quoted value of /${key}`, lines[i].line);
        }
        parts.push(lines[i].text);
        quotes += countQuotes(lines[i].text);
        i++;
      }
    }
    raws.push({ key, parts, line });
  }
  return { qualifiers: finish() };
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
 * Break position for text that readers join WITHOUT spaces (/translation): the line is
 * `rest.slice(0, j)`, as long as possible within the width but never ending with '"'. A line
 * ending with '"' ends a quoted value for Biopython 1.88 (`InsdcScanner.parse_feature` reads
 * until a line ends with a quote), and for this reader too when the quotes seen so far are even,
 * as after the first half of an escaped `""` pair: the value's quote would be read back doubled.
 * Returns -1 when no such position exists (a value made of quotes only).
 */
function findBreakAnywhere(rest: string, minimum: number): number {
  for (let j = TEXT_WIDTH; j >= minimum; j--) if (rest.charCodeAt(j - 1) !== 34) return j;
  for (let j = TEXT_WIDTH + 1; j < rest.length; j++) if (rest.charCodeAt(j - 1) !== 34) return j;
  return -1;
}

/**
 * Split `/key=value` text into lines of at most TEXT_WIDTH characters after the indent.
 * `prefix` is the length of `/key="` (no break right after the opening quote). With
 * `breakAnywhere` (values read back without spaces) lines are cut between any two characters
 * except after a '"' (see {@link findBreakAnywhere}); otherwise only at single spaces.
 */
function wrapQualifierText(text: string, prefix: number, breakAnywhere: boolean): string[] {
  const lines: string[] = [];
  let rest = text;
  let minimum = prefix + 1;
  while (rest.length > TEXT_WIDTH) {
    if (breakAnywhere) {
      const cut = findBreakAnywhere(rest, minimum);
      if (cut < 0) break;
      lines.push(INDENT + rest.slice(0, cut));
      rest = rest.slice(cut);
      minimum = 1;
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

/**
 * Split a location after commas so that each line holds at most `width` characters (default:
 * the 58 columns from column 22 to 79). Text without a comma that fits overflows up to its
 * first comma, or stays on one line.
 */
export function wrapLocation(location: string, width: number = TEXT_WIDTH): string[] {
  const lines: string[] = [];
  let rest = location;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(',', width - 1);
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
