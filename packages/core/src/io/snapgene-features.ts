/**
 * SnapGene `<Features>` XML (packet 0x0A) <-> {@link Feature}.
 *
 * File structure (fixtures; Biopython SnapGeneIO; sgffp format spec):
 *
 *   <Features nextValidID="2">
 *     <Feature recentID="0" name="AmpR" directionality="2" type="CDS" ... readingFrame="-1">
 *       <Segment range="2614-3405" color="#ccffcc" type="standard" translated="1"/>
 *       <Segment range="3406-3420" color="noColor" type="gap"/>
 *       <Segment name="signal sequence" range="3421-3474" color="#ccffcc" type="standard"/>
 *       <Q name="gene"><V text="&lt;html&gt;&lt;body&gt;bla&lt;/body&gt;&lt;/html&gt;"/></Q>
 *       <Q name="codon_start"><V int="1"/></Q>
 *     </Feature>
 *   </Features>
 *
 * Mapping and conventions:
 *  - directionality: 1 -> strand 1, 2 -> strand -1, absent / 0 / 3 (bidirectional) -> 0.
 *  - Segment `range="a-b"` is 1-based inclusive; a > b wraps the origin and becomes ONE
 *    wrapping segment `{ start: a-1, end: b+L }` (Biopython instead splits it into two parts).
 *  - SnapGene lists segments in ascending top-strand order for both strands (sample-f.dna:
 *    a reverse feature with `swappedSegmentNumbering="1"` lists 400-499, 517-634, 635-724), which
 *    is already the types.ts order, so it is kept as is.
 *  - `type="gap"` segments are the holes between the parts of a split feature (like the gaps
 *    between the ranges of a GenBank `join`); they are skipped, as Biopython does, and the writer
 *    re-creates them between non-adjacent segments, as SnapGene does.
 *  - The first standard segment's colour becomes `feature.color`.
 *  - Segment names are kept in a `parts` qualifier ("1:name;3:name", segments numbered 5'->3'
 *    along the feature), the convention introduced by Biopython.
 *  - `<Q name><V text|predef|int/></Q>` -> one qualifier per V; SnapGene's HTML wrapper is
 *    removed (see `richTextToPlain`); `predef` + `text` is a controlled-vocabulary prefix,
 *    e.g. `<V text="238030067" predef="GI"/>` -> `GI:238030067` (Biopython keeps only the text).
 *  - The feature `name` attribute is the display name; the first `/label` is made equal to it
 *    so that a GenBank export keeps the name (see `ensureLabel`).
 *  - `readingFrame` is the frame SnapGene translates a directional feature in (sign = strand,
 *    magnitude = GenBank /codon_start; see `applyReadingFrame`). It wins over a `codon_start`
 *    qualifier: SnapGene does not update that qualifier when the frame changes, and files of
 *    SnapGene's own plasmid library (T-Vector pMD20, pMD19 (Simple), pTZ57R/T, pUC57-T) carry a
 *    stale codon_start=1 next to readingFrame="±2", with a stored /translation in frame 2.
 */
import { featureLabel, makeFeature } from '../seq/features';
import { mod, normalizeRange } from '../seq/range';
import type { Feature, Qualifier, Range, Strand, Topology } from '../types';
import type { ParseWarning } from './types';
import { childElements, plainToRichText, richTextToPlain, xmlElement, type XmlElement } from './snapgene-markup';
import { clip } from './snapgene-messages';

/** Feature type used when the `type` attribute is missing (as in Biopython). */
const DEFAULT_FEATURE_TYPE = 'misc_feature';

/**
 * Colour written for features without one, by type. SnapGene always stores a segment colour;
 * these are the colours SnapGene itself used for these types in the fixtures
 * (pFA-KanMX4.dna, sample-d/e/f.dna, sample-hybridization-params.dna).
 */
const DEFAULT_COLORS: ReadonlyMap<string, string> = new Map([
  ['CDS', '#993366'],
  ['promoter', '#ffffff'],
  ['terminator', '#ffffff'],
  ['rep_origin', '#ffff00'],
]);
/** SnapGene's grey, used in the fixtures for misc_feature, misc_binding and oriT. */
const FALLBACK_COLOR = '#a6acb3';

/** Qualifiers SnapGene stores as `<V int="..."/>` (pFA-KanMX4.dna, sample-hybridization-params.dna). */
const INTEGER_QUALIFIERS: ReadonlySet<string> = new Set(['codon_start', 'transl_table']);

/** Qualifier holding segment names (Biopython's convention). */
const PARTS_QUALIFIER = 'parts';

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function strandFromDirectionality(raw: string | undefined, who: string, warnings: ParseWarning[]): Strand {
  const value = raw?.trim();
  if (value === '1') return 1;
  if (value === '2') return -1;
  if (value !== undefined && value !== '' && value !== '0' && value !== '3') {
    warnings.push({ message: `${who}: unknown directionality "${clip(value)}"; read as non-directional.` });
  }
  return 0;
}

/**
 * A SnapGene segment range "a-b" (1-based, inclusive) as ranges of the types.ts model.
 * a > b wraps the origin: one wrapping range on a circular sequence, two ranges
 * ([a-1, L) then [0, b), as Biopython does) on a linear one. Undefined if malformed or out of bounds.
 */
export function parseSegmentRange(text: string, seqLength: number, topology: Topology): Range[] | undefined {
  const match = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(text);
  if (match === null) return undefined;
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (first < 1 || last < 1 || first > seqLength || last > seqLength) return undefined;
  if (first <= last) return [{ start: first - 1, end: last }];
  if (topology === 'circular') return [{ start: first - 1, end: last + seqLength }];
  return [
    { start: first - 1, end: seqLength },
    { start: 0, end: last },
  ];
}

/** '#rrggbb' (lowercase) for '#rrggbb' or '#rgb' input; undefined for anything else (e.g. 'noColor'). */
export function normalizeColor(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (value === undefined) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) return `#${[...value.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
  return undefined;
}

/** Integer text as Python's `str(int(text))` would print it; other text is returned trimmed. */
function normalizeInteger(raw: string): string {
  const value = raw.trim();
  if (!/^[+-]?\d+$/.test(value)) return value;
  const n = Number(value);
  return Number.isSafeInteger(n) ? String(n) : value;
}

/** The value of one `<V>` element. */
function qualifierValue(v: XmlElement): string {
  const text = v.attributes.get('text');
  const predef = v.attributes.get('predef');
  if (text !== undefined) {
    const plain = richTextToPlain(text, 'line');
    const prefix = predef === undefined ? '' : richTextToPlain(predef, 'line');
    return prefix !== '' ? `${prefix}:${plain}` : plain;
  }
  if (predef !== undefined) return richTextToPlain(predef, 'line');
  const int = v.attributes.get('int');
  if (int !== undefined) return normalizeInteger(int);
  return '';
}

/**
 * SnapGene separates the translations of a feature's segments with commas and ends the
 * translation of a CDS that hits a stop codon with '*' (pFA-KanMX4.dna: "...LPVFA,HPETL...W*").
 * Neither belongs to an INSDC /translation, so both are removed.
 */
function cleanQualifierValue(key: string, value: string): string {
  return key === 'translation' ? value.replace(/,/g, '').replace(/\*$/, '') : value;
}

/**
 * Biopython-style `parts` value: "index:name" pairs joined with ';', where segments are
 * numbered 1..n along the feature 5'->3' (for a reverse feature, from the rightmost segment).
 */
function formatParts(names: ReadonlyArray<readonly [number, string]>, segmentCount: number, strand: Strand): string {
  return names
    .map(([index, name]) => [strand === -1 ? segmentCount - index : index + 1, name] as const)
    .sort((a, b) => a[0] - b[0])
    .map(([n, name]) => `${n}:${name}`)
    .join(';');
}

/** A translation frame: GenBank /codon_start, the 1-based offset of the first codon. */
type Frame = 1 | 2 | 3;

/**
 * The frame of a SnapGene `readingFrame` attribute ("2", "-3", "+1": sign = strand, magnitude =
 * frame), or undefined with a warning when the value is not one.
 */
function parseReadingFrame(raw: string, who: string, warnings: ParseWarning[]): Frame | undefined {
  const match = /^\s*[+-]?(\d+)\s*$/.exec(raw);
  if (match === null) {
    warnings.push({ message: `${who}: unreadable readingFrame "${clip(raw)}"; ignored.` });
    return undefined;
  }
  const frame = Number(match[1]);
  if (frame === 1 || frame === 2 || frame === 3) return frame;
  warnings.push({ message: `${who}: readingFrame "${clip(raw.trim())}" is not a reading frame (±1, ±2 or ±3); ignored.` });
  return undefined;
}

/** The frame a /codon_start value denotes: an unsigned decimal 1, 2 or 3 ("2", "02", "+2"); else undefined. */
function denotedFrame(value: string | null | undefined): Frame | undefined {
  const match = value === null || value === undefined ? null : /^\s*\+?([0-9]+)\s*$/.exec(value);
  const n = match === null ? 0 : Number(match[1]);
  return n === 1 || n === 2 || n === 3 ? n : undefined;
}

/** Most /codon_start values quoted in one warning. */
const MAX_QUOTED_VALUES = 5;

/** The given /codon_start values as the subject of a warning sentence, with the matching verb form. */
function describeCodonStarts(values: ReadonlyArray<string | null>): { subject: string; plural: boolean } {
  if (values.length === 1) {
    const value = values[0];
    return { subject: value === null ? '/codon_start without a value' : `/codon_start=${clip(value)}`, plural: false };
  }
  const shown = values.slice(0, MAX_QUOTED_VALUES).map((v) => (v === null ? '(no value)' : clip(v)));
  return { subject: `/codon_start values ${shown.join(', ')}${values.length > MAX_QUOTED_VALUES ? ', ...' : ''}`, plural: true };
}

/**
 * Apply SnapGene's `readingFrame` attribute to the qualifiers of a feature being read.
 *
 * `readingFrame` is the frame SnapGene translates the feature in: its sign is the strand and its
 * magnitude the GenBank /codon_start (fixtures; PlasmidPop issues #153 and #164, established on
 * the files bundled with SnapGene 8.2). SnapGene keeps a `codon_start` qualifier imported from
 * GenBank but does not update it when the frame changes, so the attribute wins:
 *  - a /codon_start that does not denote the frame (or several values, or one without a value) is
 *    replaced, at the position of the first, by /codon_start=frame, with a warning;
 *  - without /codon_start, frames 2 and 3 add one (frame 1 is the default and adds nothing:
 *    SnapGene writes readingFrame="-1" on every reverse feature).
 * The qualifier is kept as it is when the attribute is absent (third-party writers; SnapGene also
 * omits it for forward features in frame 1) or invalid, and on non-directional features, which
 * SnapGene does not translate and on which it writes a meaningless default of -1 (protein_bind
 * features of T-Vector pMD19 (Simple), pTZ57R/T, pUC57-T).
 */
function applyReadingFrame(raw: string | undefined, strand: Strand, qualifiers: Qualifier[], who: string, warnings: ParseWarning[]): void {
  if (raw === undefined) return;
  const frame = parseReadingFrame(raw, who, warnings);
  if (frame === undefined || strand === 0) return;
  const positions: number[] = [];
  qualifiers.forEach((q, i) => {
    if (q.key === 'codon_start') positions.push(i);
  });
  const values = positions.map((i) => qualifiers[i].value);
  if (values.every((value) => denotedFrame(value) === frame)) {
    if (positions.length === 0 && frame !== 1) qualifiers.push({ key: 'codon_start', value: String(frame) });
    return;
  }
  const { subject, plural } = describeCodonStarts(values);
  warnings.push({
    message: `${who}: ${subject} ${plural ? 'disagree' : 'disagrees'} with SnapGene's reading frame (readingFrame="${clip(raw.trim())}"); /codon_start was set to ${frame}.`,
  });
  // One pass, in place: the first codon_start becomes the frame, the others are dropped.
  let kept = 0;
  for (let i = 0; i < qualifiers.length; i++) {
    const q = qualifiers[i];
    if (q.key !== 'codon_start') qualifiers[kept++] = q;
    else if (i === positions[0]) qualifiers[kept++] = { key: 'codon_start', value: String(frame) };
  }
  qualifiers.length = kept;
}

/**
 * Make the first /label equal the SnapGene name, so a later GenBank export (and re-import)
 * keeps the name: append one when there is no /label (as Biopython does), or insert one
 * before the existing labels when the first differs (Biopython adds a /name qualifier instead).
 */
function ensureLabel(qualifiers: Qualifier[], name: string): void {
  const first = qualifiers.findIndex((q) => q.key === 'label');
  if (first < 0) qualifiers.push({ key: 'label', value: name });
  else if (qualifiers[first].value !== name) qualifiers.splice(first, 0, { key: 'label', value: name });
}

function parseFeature(element: XmlElement, index: number, seqLength: number, topology: Topology, warnings: ParseWarning[]): Feature | undefined {
  const rawName = element.attributes.get('name');
  const name = rawName === undefined ? '' : richTextToPlain(rawName, 'line');
  const who = name !== '' ? `Feature "${clip(name)}"` : `Feature #${index + 1}`;
  const type = (element.attributes.get('type') ?? '').trim() || DEFAULT_FEATURE_TYPE;
  const strand = strandFromDirectionality(element.attributes.get('directionality'), who, warnings);

  const segments: Range[] = [];
  const segmentNames: Array<[number, string]> = [];
  let color: string | undefined;
  for (const segment of childElements(element, 'Segment')) {
    if ((segment.attributes.get('type') ?? '').trim() === 'gap') continue;
    const rangeText = segment.attributes.get('range') ?? '';
    const ranges = parseSegmentRange(rangeText, seqLength, topology);
    if (ranges === undefined) {
      warnings.push({ message: `${who}: segment range "${clip(rangeText)}" is not valid for this ${seqLength} bp sequence; segment skipped.` });
      continue;
    }
    if (ranges.length > 1) {
      warnings.push({ message: `${who}: segment "${clip(rangeText)}" crosses the origin of a linear sequence; split into two segments.` });
    }
    const segmentName = richTextToPlain(segment.attributes.get('name') ?? '', 'line');
    if (segmentName !== '') segmentNames.push([segments.length, segmentName]);
    segments.push(...ranges);
    color ??= normalizeColor(segment.attributes.get('color'));
  }
  if (segments.length === 0) {
    warnings.push({ message: `${who} has no valid segment; feature skipped.` });
    return undefined;
  }

  const qualifiers: Qualifier[] = [];
  let hasPartsQualifier = false;
  for (const q of childElements(element, 'Q')) {
    const key = (q.attributes.get('name') ?? '').trim();
    if (key === '') {
      warnings.push({ message: `${who}: qualifier without a name; skipped.` });
      continue;
    }
    if (key === PARTS_QUALIFIER) hasPartsQualifier = true;
    const values = childElements(q, 'V');
    if (values.length === 0) qualifiers.push({ key, value: null });
    for (const v of values) qualifiers.push({ key, value: cleanQualifierValue(key, qualifierValue(v)) });
  }
  if (segmentNames.length > 0 && !hasPartsQualifier) {
    qualifiers.unshift({ key: PARTS_QUALIFIER, value: formatParts(segmentNames, segments.length, strand) });
  }
  applyReadingFrame(element.attributes.get('readingFrame'), strand, qualifiers, who, warnings);
  if (name !== '') ensureLabel(qualifiers, name);

  return makeFeature({
    type,
    name: name !== '' ? name : featureLabel(type, qualifiers),
    strand,
    segments,
    qualifiers,
    ...(color !== undefined ? { color } : {}),
  });
}

/**
 * Read the features of a `<Features>` element. Coordinates follow types.ts (0-based,
 * half-open; wrapping segments have end > L). Invalid segments and features without any valid
 * segment are skipped with a warning.
 */
export function parseFeatures(root: XmlElement, seqLength: number, topology: Topology, warnings: ParseWarning[]): Feature[] {
  const features: Feature[] = [];
  childElements(root, 'Feature').forEach((element, index) => {
    const feature = parseFeature(element, index, seqLength, topology, warnings);
    if (feature !== undefined) features.push(feature);
  });
  return features;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** A segment or gap to write, in unwrapped coordinates (start may exceed L on circular molecules). */
interface SegmentPiece {
  range: Range;
  gap: boolean;
  /** Index into the feature's written segments (-1 for gaps). */
  index: number;
}

/** 1-based inclusive "a-b" text for a normalized range (wrapping ranges give a > b). */
export function formatSegmentRange(range: Range, seqLength: number): string {
  return `${range.start + 1}-${range.end > seqLength ? range.end - seqLength : range.end}`;
}

/** Bring an unwrapped range back into normalized form (start in [0, L)). */
function rewrap(range: Range, seqLength: number, topology: Topology): Range {
  if (topology !== 'circular' || range.start < seqLength) return range;
  const start = mod(range.start, seqLength);
  return { start, end: start + (range.end - range.start) };
}

function describeRange(r: Range): string {
  return `${r.start}..${r.end}`;
}

/** The feature's segments that can be written, normalized; the others are reported. */
function writableSegments(feature: Feature, seqLength: number, topology: Topology, who: string, warnings: ParseWarning[]): Range[] {
  const out: Range[] = [];
  for (const segment of feature.segments) {
    const { start, end } = segment;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      warnings.push({ message: `${who}: segment ${describeRange(segment)} has non-integer coordinates; not written.` });
      continue;
    }
    if (topology === 'circular' && seqLength > 0) {
      const normalized = normalizeRange(segment, seqLength, 'circular');
      if (normalized.end === normalized.start) {
        warnings.push({ message: `${who}: empty segment ${describeRange(segment)} cannot be stored in a SnapGene file; not written.` });
        continue;
      }
      if (normalized.start !== start || normalized.end !== end) {
        warnings.push({ message: `${who}: segment ${describeRange(segment)} is not in normalized form; written as ${describeRange(normalized)}.` });
      }
      out.push(normalized);
    } else if (start < 0 || end > seqLength || start >= end) {
      const reason = start === end ? 'is empty and cannot be stored in a SnapGene file' : `is outside the ${seqLength} bp sequence`;
      warnings.push({ message: `${who}: segment ${describeRange(segment)} ${reason}; not written.` });
    } else {
      out.push({ start, end });
    }
  }
  return out;
}

/**
 * Lay segments out the way SnapGene stores them: in the given (top-strand) order, with a gap
 * segment wherever the next segment starts after the previous ones end. On circular molecules
 * each segment is placed at the first position at or after the previous segment's start, so
 * multi-segment features may run across the origin.
 */
function layoutSegments(segments: readonly Range[], seqLength: number, topology: Topology): { pieces: SegmentPiece[]; overlaps: boolean; problem?: string } {
  const pieces: SegmentPiece[] = [{ range: segments[0], gap: false, index: 0 }];
  let overlaps = false;
  let ascending = true;
  let previousStart = segments[0].start;
  let reach = segments[0].end;
  const circular = topology === 'circular' && seqLength > 0;
  for (let k = 1; k < segments.length; k++) {
    const segment = segments[k];
    let start = segment.start;
    if (circular) start += seqLength * Math.ceil(Math.max(0, previousStart - start) / seqLength);
    else if (start < previousStart) ascending = false;
    const end = start + (segment.end - segment.start);
    if (start > reach) pieces.push({ range: { start: reach, end: start }, gap: true, index: -1 });
    else if (start < reach) overlaps = true;
    pieces.push({ range: { start, end }, gap: false, index: k });
    previousStart = start;
    reach = Math.max(reach, end);
  }
  let problem: string | undefined;
  if (!ascending) problem = 'segments are not in ascending order, which SnapGene cannot represent faithfully';
  else if (circular && reach - segments[0].start > seqLength) problem = 'segments run more than once around the circular sequence';
  return {
    pieces: pieces.map((p) => ({ ...p, range: rewrap(p.range, seqLength, topology) })),
    overlaps,
    ...(problem !== undefined ? { problem } : {}),
  };
}

/**
 * Segment names from a Biopython-style `parts` qualifier ("1:name;3:name", numbered 5'->3'
 * along the feature). Returns undefined when the qualifier is absent or does not describe the
 * written segments exactly (it is then written as an ordinary qualifier).
 */
function segmentNamesFromParts(feature: Feature, segmentCount: number): { names: Map<number, string>; source: Qualifier } | undefined {
  const source = feature.qualifiers.find((q) => q.key === PARTS_QUALIFIER);
  if (source === undefined || source.value === null || segmentCount !== feature.segments.length) return undefined;
  const names = new Map<number, string>();
  for (const entry of source.value.split(';')) {
    const match = /^\s*(\d+)\s*:(.*)$/.exec(entry);
    if (match === null) return undefined;
    const n = Number(match[1]);
    const name = match[2].trim();
    if (n < 1 || n > segmentCount || name === '') return undefined;
    const index = feature.strand === -1 ? segmentCount - n : n - 1;
    if (names.has(index)) return undefined;
    names.set(index, name);
  }
  return { names, source };
}

function featureColor(feature: Feature, type: string, who: string, warnings: ParseWarning[]): string {
  const color = normalizeColor(feature.color);
  if (color !== undefined) return color;
  if (feature.color !== undefined) warnings.push({ message: `${who}: colour "${clip(String(feature.color))}" is not '#rrggbb'; the default colour was written.` });
  return DEFAULT_COLORS.get(type) ?? FALLBACK_COLOR;
}

function buildQualifiersXml(qualifiers: readonly Qualifier[], skip: Qualifier | undefined, who: string, warnings: ParseWarning[]): string {
  // SnapGene keeps the values of a qualifier together under one <Q>.
  const groups = new Map<string, Array<string | null>>();
  for (const q of qualifiers) {
    if (q === skip) continue;
    const key = q.key.trim();
    if (key === '') {
      warnings.push({ message: `${who}: qualifier with an empty name; not written.` });
      continue;
    }
    const values = groups.get(key) ?? [];
    values.push(q.value);
    groups.set(key, values);
  }
  let xml = '';
  for (const [key, values] of groups) {
    const present = values.filter((v): v is string => v !== null);
    if (present.length === 0) {
      xml += xmlElement('Q', [['name', key]]);
      continue;
    }
    if (present.length < values.length) {
      warnings.push({ message: `${who}: value-less /${clip(key)} not written because /${clip(key)} also has values.` });
    }
    const valueXml = present
      .map((value) => (INTEGER_QUALIFIERS.has(key) && /^(0|-?[1-9]\d*)$/.test(value) ? xmlElement('V', [['int', value]]) : xmlElement('V', [['text', plainToRichText(value)]])))
      .join('');
    xml += xmlElement('Q', [['name', key]], valueXml);
  }
  return xml;
}

/**
 * SnapGene's `readingFrame` attribute for a feature (undefined: not written), as SnapGene writes it
 * (fixtures): -frame on every reverse feature, +frame on forward features in frame 2 or 3, none
 * otherwise. The frame is the feature's first /codon_start when that denotes 1, 2 or 3, else 1.
 * The reader lets this attribute win over /codon_start (see `applyReadingFrame`), so /codon_start
 * values that do not all denote the written frame are reported: they read back as that frame.
 */
function writtenReadingFrame(feature: Feature, who: string, warnings: ParseWarning[]): string | undefined {
  if (feature.strand !== 1 && feature.strand !== -1) return undefined;
  const values = feature.qualifiers.filter((q) => q.key === 'codon_start').map((q) => q.value);
  const frame = denotedFrame(values[0]) ?? 1;
  if (feature.strand === 1 && frame === 1) return undefined;
  const readingFrame = String(feature.strand * frame);
  if (!values.every((value) => denotedFrame(value) === frame)) {
    const { subject, plural } = describeCodonStarts(values);
    warnings.push({
      message: `${who}: ${subject} ${plural ? 'do' : 'does'} not give one reading frame (1, 2 or 3); readingFrame="${readingFrame}" was written, so the file reads back with /codon_start=${frame}.`,
    });
  }
  return readingFrame;
}

function buildFeatureXml(feature: Feature, recentId: number, seqLength: number, topology: Topology, warnings: ParseWarning[]): string | undefined {
  const name = feature.name.trim() || featureLabel(feature.type, feature.qualifiers);
  const type = feature.type.trim() || DEFAULT_FEATURE_TYPE;
  const who = `Feature "${clip(name)}"`;
  const segments = writableSegments(feature, seqLength, topology, who, warnings);
  if (segments.length === 0) {
    warnings.push({ message: `${who} has no segment that can be written; feature not written.` });
    return undefined;
  }
  const layout = layoutSegments(segments, seqLength, topology);
  if (layout.problem !== undefined) warnings.push({ message: `${who}: ${layout.problem}.` });
  const parts = segmentNamesFromParts(feature, segments.length);
  const color = featureColor(feature, type, who, warnings);
  const translated = type === 'CDS' ? '1' : undefined;

  let content = '';
  for (const piece of layout.pieces) {
    const range = formatSegmentRange(piece.range, seqLength);
    content += piece.gap
      ? xmlElement('Segment', [['range', range], ['color', 'noColor'], ['type', 'gap']])
      : xmlElement('Segment', [
          ['name', parts?.names.get(piece.index)],
          ['range', range],
          ['color', color],
          ['type', 'standard'],
          ['translated', translated],
        ]);
  }
  content += buildQualifiersXml(feature.qualifiers, parts?.source, who, warnings);
  const readingFrame = writtenReadingFrame(feature, who, warnings);
  // Attribute order as written by SnapGene (fixtures). SnapGene hides 'source' features
  // (visible="0" in PlasmidPop's frame_test.dna, written by SnapGene from a GenBank import).
  return xmlElement(
    'Feature',
    [
      ['recentID', String(recentId)],
      ['name', plainToRichText(name)],
      ['directionality', feature.strand === 1 ? '1' : feature.strand === -1 ? '2' : undefined],
      ['type', type],
      ['swappedSegmentNumbering', feature.strand === -1 ? '1' : undefined],
      ['allowSegmentOverlaps', layout.overlaps ? '1' : '0'],
      ['readingFrame', readingFrame],
      ['consecutiveTranslationNumbering', '1'],
      ['visible', type === 'source' ? '0' : undefined],
    ],
    content,
  );
}

/**
 * Build the `<Features>` packet text, or undefined when no feature can be written (SnapGene
 * omits the packet for sequences without features). Features whose segments are all invalid
 * are skipped; everything that is dropped or altered is reported in `warnings`.
 */
export function buildFeaturesXml(features: readonly Feature[], seqLength: number, topology: Topology, warnings: ParseWarning[]): string | undefined {
  const written: string[] = [];
  let fuzzy = 0;
  for (const feature of features) {
    const xml = buildFeatureXml(feature, written.length, seqLength, topology, warnings);
    if (xml === undefined) continue;
    written.push(xml);
    if (feature.partialStart === true || feature.partialEnd === true) fuzzy++;
  }
  if (fuzzy > 0) {
    warnings.push({ message: `${fuzzy} feature(s) have partial (fuzzy) ends, which SnapGene files cannot store; they were written with exact ends.` });
  }
  if (written.length === 0) return undefined;
  return `<?xml version="1.0"?>${xmlElement('Features', [['nextValidID', String(written.length)]], written.join(''))}\n`;
}
