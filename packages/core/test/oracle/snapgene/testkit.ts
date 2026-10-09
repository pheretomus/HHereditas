/**
 * Shared helpers for the SnapGene tests (src/io/snapgene*.test.ts): types of the oracle JSON
 * written by tools/oracle/snapgene_oracle.py, comparison helpers, a seeded PRNG, a random
 * record generator for writer tests and a checker for the types.ts record invariants.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { featureLabel } from '../../../src/seq/features';
import { splitAtOrigin } from '../../../src/seq/range';
import type { DnaEnd, Feature, FragmentEnds, Primer, Qualifier, RecordMeta, SeqRecord, Topology } from '../../../src/types';

export const ORACLE_DIR = dirname(fileURLToPath(import.meta.url));
export const CORE_DIR = join(ORACLE_DIR, '..', '..', '..');
export const REPO_DIR = join(CORE_DIR, '..', '..');
export const FIXTURE_DIR = join(CORE_DIR, 'test', 'fixtures', 'snapgene');
export const ORACLE_SCRIPT = join(REPO_DIR, 'tools', 'oracle', 'snapgene_oracle.py');
export const ORACLE_PYTHON = join(REPO_DIR, 'tools', 'oracle', '.venv', 'bin', 'python');

// ---------------------------------------------------------------------------
// Oracle JSON
// ---------------------------------------------------------------------------

export type BioValue = string | number;

export interface BiopythonFeature {
  type: string;
  parts: Array<[number, number, number]>;
  qualifiers: Array<[string, BioValue[]]>;
}

export interface BiopythonFile {
  error?: string;
  id?: string;
  name?: string;
  description?: string;
  seq?: string;
  topology?: string;
  division?: string;
  date?: string | null;
  feature_types?: string[];
}

/** Categories of disagreement between our reading and Biopython's (see snapgene-oracle.test.ts). */
export type AlignmentCategory =
  | 'same'
  | 'html'
  | 'predef'
  | 'translation'
  | 'plain-markup'
  | 'duplicate-q'
  | 'no-value'
  | 'empty-v'
  | 'reading-frame'
  | 'label-first'
  | 'unexplained';

export interface ExpectedFeature {
  type: string;
  name: string;
  strand: number;
  segments: Array<[number, number]>;
  qualifiers: Array<[string, string | null]>;
  color?: string;
  segment_groups: number[];
  sources: unknown[];
  biopython: BiopythonFeature | null;
  alignment: Array<[AlignmentCategory, BioValue | null]> | null;
}

export interface ExpectedRecord {
  name: string;
  description: string;
  seq: string;
  topology: Topology;
  features: ExpectedFeature[];
  primers: Array<{ name: string; sequence: string; description?: string }>;
  ends?: FragmentEnds;
  meta: RecordMeta;
}

export interface OracleEntry {
  biopython: BiopythonFile;
  raw: { packets: Array<[number, number, number]>; truncated: unknown; cookie?: number[] | null; dna?: { flags: number; length: number } };
  expected: ExpectedRecord | null;
  /** Base64 file contents (random corpus only). */
  data?: string;
}

export interface OracleFile<T> {
  biopython: string;
  files: T;
}

/** Parse a JSON file of the oracle directory. */
export function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(ORACLE_DIR, name), 'utf8')) as T;
}

export function loadOracle<T>(name: string): OracleFile<T> {
  return loadJson<OracleFile<T>>(name);
}

/** Feature metadata keys written by the oracle that are not part of the record. */
const FEATURE_METADATA = ['segment_groups', 'sources', 'biopython', 'alignment'];

/** The oracle's expected record without its test metadata. */
export function comparableExpected(expected: ExpectedRecord): unknown {
  return {
    ...expected,
    features: expected.features.map((f) => Object.fromEntries(Object.entries(f).filter(([k]) => !FEATURE_METADATA.includes(k)))),
  };
}

/** A record in the oracle's shape: ids dropped, ranges as [start, end], qualifiers as [key, value]. */
export function comparableRecord(record: SeqRecord): unknown {
  return {
    name: record.name,
    description: record.description,
    seq: record.seq,
    topology: record.topology,
    features: record.features.map((f) => ({
      type: f.type,
      name: f.name,
      strand: f.strand,
      segments: f.segments.map((s) => [s.start, s.end]),
      qualifiers: f.qualifiers.map((q) => [q.key, q.value]),
      ...(f.color !== undefined ? { color: f.color } : {}),
    })),
    primers: record.primers.map((p) => ({ name: p.name, sequence: p.sequence, ...(p.description !== undefined ? { description: p.description } : {}) })),
    ...(record.ends !== undefined ? { ends: record.ends } : {}),
    meta: record.meta,
  };
}

/**
 * Biopython's location parts for one of our features. Biopython splits a segment that wraps the
 * origin into [tail, head] and, for reverse features, lists the SnapGene Segment elements in
 * reverse order (keeping each element's own parts in order). `groups` gives the number of our
 * segments that came from each Segment element (2 for a range that wraps a linear sequence).
 */
export function biopythonParts(feature: Pick<Feature, 'segments' | 'strand'>, seqLength: number, groups?: readonly number[]): Array<[number, number, number]> {
  const strand = feature.strand === -1 ? -1 : 1;
  const counts = groups ?? feature.segments.map(() => 1);
  const elements: Array<Array<[number, number, number]>> = [];
  let index = 0;
  for (const count of counts) {
    elements.push(
      feature.segments.slice(index, index + count).flatMap((s) => splitAtOrigin(s, seqLength).map((p): [number, number, number] => [p.start, p.end, strand])),
    );
    index += count;
  }
  if (feature.strand === -1) elements.reverse();
  return elements.flat();
}

/** Base64 to bytes. */
export function fromBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'));
}

// ---------------------------------------------------------------------------
// Comparison with Biopython
// ---------------------------------------------------------------------------

/** Every way our reading may deliberately differ from Biopython's, with the reason. */
export const DOCUMENTED_DEVIATIONS: Readonly<Record<string, string>> = {
  html: 'SnapGene HTML rich text: we also decode character references (&amp;amp; -> &), collapse whitespace and render block elements as spaces; Biopython only strips tags',
  predef: 'controlled-vocabulary prefix kept: <V text="238030067" predef="GI"/> is "GI:238030067"; Biopython keeps only the text',
  translation: 'SnapGene segment separators (",") and the final stop ("*") are removed from /translation, and its "?" for a codon with ambiguous bases becomes the INSDC "X"',
  'plain-markup': 'plain values containing "<...>" are kept verbatim; Biopython strips anything tag-like even from plain text',
  'duplicate-q': 'several <Q> elements with the same name: we keep every value; Biopython keeps the last element only',
  'no-value': 'a <Q> without <V> is a value-less qualifier (null); Biopython stores an empty list',
  'empty-v': 'a <V/> without attributes is an empty value; Biopython drops it',
  'reading-frame': "SnapGene's readingFrame sets /codon_start on directional features: frames 2/3 add it, and a stale /codon_start that disagrees is replaced; Biopython ignores readingFrame",
  'label-first': 'the SnapGene name is inserted as the first /label; Biopython adds a /name qualifier instead',
  'strand-0': 'directionality absent/0/3 is strand 0; Biopython reads it as +1',
  'notes-merged':
    'several Notes packets are read as one (later fields win, a field missing from a later packet keeps its earlier value); Biopython reads them one by one and takes the division from the last packet alone (UNC unless its Type is Synthetic)',
};

/** Deviations counted per feature or per file rather than per qualifier value. */
export const NON_QUALIFIER_DEVIATIONS: readonly string[] = ['strand-0', 'notes-merged'];

/** Tally of compared items, keyed by category. */
export type Tally = Record<string, number>;

function bump(tally: Tally, key: string, by = 1): void {
  tally[key] = (tally[key] ?? 0) + by;
}

/**
 * Compare one of our features with Biopython's reading of the same <Feature> (attached to the
 * oracle's expected feature, with the qualifier alignment computed by the oracle from the raw
 * XML). Returns the problems found; tallies every compared item by category.
 */
export function compareFeatureWithBiopython(ours: Feature, expected: ExpectedFeature, seqLength: number, tally: Tally): string[] {
  const bio = expected.biopython;
  if (bio === null || expected.alignment === null) {
    bump(tally, 'feature-not-compared (Biopython rejected the features packet)');
    return [];
  }
  const where = `feature "${ours.name}"`;
  const problems: string[] = [];
  bump(tally, 'features compared');
  if (ours.type !== bio.type) problems.push(`${where}: type ${ours.type} vs ${bio.type}`);
  const parts = biopythonParts(ours, seqLength, expected.segment_groups);
  if (JSON.stringify(parts) === JSON.stringify(bio.parts)) bump(tally, 'location same');
  else problems.push(`${where}: location ${JSON.stringify(parts)} vs Biopython ${JSON.stringify(bio.parts)}`);
  if (ours.strand === 0) bump(tally, 'strand-0');
  if (ours.qualifiers.length !== expected.alignment.length) {
    problems.push(`${where}: ${ours.qualifiers.length} qualifiers vs ${expected.alignment.length} aligned`);
    return problems;
  }
  expected.alignment.forEach(([category, bioValue], i) => {
    const value = ours.qualifiers[i].value;
    bump(tally, category);
    const describe = `${where} /${ours.qualifiers[i].key}=${JSON.stringify(value)} (Biopython ${JSON.stringify(bioValue)})`;
    if (category === 'unexplained') problems.push(`${describe}: unexplained difference`);
    else if (category === 'same' && value !== String(bioValue)) problems.push(`${describe}: expected the same value`);
    else if (category === 'predef' && !(value ?? '').endsWith(`:${String(bioValue)}`)) problems.push(`${describe}: not a predef prefix`);
    else if (category === 'translation' && value !== String(bioValue).replace(/,/g, '').replace(/\*$/, '').replace(/\?/g, 'X')) problems.push(`${describe}: not a translation clean-up`);
    else if (!(category in DOCUMENTED_DEVIATIONS) && category !== 'same') problems.push(`${describe}: unknown category ${category}`);
  });
  return problems;
}

const MONTH_NUMBER: Readonly<Record<string, string>> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

/** SnapGene packet type of the Notes packets (0x06). */
const NOTES_PACKET = 0x06;

/** Compare record-level fields with Biopython's reading of the whole file (`entry.raw` tells how many Notes packets it has). */
export function compareRecordWithBiopython(ours: SeqRecord, entry: Pick<OracleEntry, 'biopython' | 'raw'>, tally: Tally): string[] {
  const bio = entry.biopython;
  if (bio.error !== undefined) {
    bump(tally, 'file rejected by Biopython');
    return [];
  }
  const problems: string[] = [];
  bump(tally, 'files compared');
  const bioSeq = [...(bio.seq ?? '').toUpperCase()].map((c) => (c === 'U' ? 'T' : 'ACGTRYSWKMBDHVN'.includes(c) ? c : 'N')).join('');
  if (bioSeq !== ours.seq) problems.push('sequence differs from Biopython (after upper-casing, U->T, non-IUPAC->N)');
  if (bio.topology !== ours.topology) problems.push(`topology ${ours.topology} vs ${String(bio.topology)}`);
  // Biopython derives the description from the Comments field; we read Description and keep Comments in meta.comments.
  if (bio.description !== '<unknown description>' && ours.meta.comments === undefined) problems.push('Biopython found Comments but we did not');
  if (bio.description !== '<unknown description>' && bio.description === ours.meta.comments?.[0]) bump(tally, 'comments same as Biopython description');
  // Biopython sets the division from each Notes packet in turn, so the last one decides; we merge the
  // packets (snapgene-notes.ts), so with several Notes packets the divisions may differ ('notes-merged').
  if (entry.raw.packets.filter(([type]) => type === NOTES_PACKET).length > 1) bump(tally, 'notes-merged');
  else if ((bio.division === 'SYN') !== (ours.meta.division === 'SYN')) problems.push(`division ${String(ours.meta.division)} vs ${String(bio.division)}`);
  if (bio.date) {
    const [year, month, day] = bio.date.split('-');
    const ourDate = ours.meta.date === undefined ? undefined : `${ours.meta.date.slice(7)}-${MONTH_NUMBER[ours.meta.date.slice(3, 6)]}-${ours.meta.date.slice(0, 2)}`;
    if (ourDate !== `${year}-${month}-${day}`) problems.push(`date ${String(ours.meta.date)} vs ${bio.date}`);
  }
  if (ours.meta.accession !== undefined && bio.id !== ours.meta.accession) problems.push(`accession ${ours.meta.accession} vs id ${String(bio.id)}`);
  return problems;
}

// ---------------------------------------------------------------------------
// Building SnapGene files in memory (independent of the writer under test)
// ---------------------------------------------------------------------------

/** Concatenate byte arrays; strings are UTF-8 encoded. */
export function concatBytes(...parts: Array<string | ArrayLike<number>>): Uint8Array {
  const chunks = parts.map((p) => (typeof p === 'string' ? new TextEncoder().encode(p) : Uint8Array.from(p)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** One packet: type byte, big-endian uint32 payload length, payload (strings are UTF-8 encoded). */
export function snapGenePacket(type: number, payload: string | ArrayLike<number>): Uint8Array {
  const body = concatBytes(payload);
  const n = body.length;
  return concatBytes([type, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255], body);
}

/** The cookie packet of a DNA file with the versions written by SnapGene 6 to 8 (export 15, import 19). */
export const DNA_COOKIE_PACKET: Uint8Array = snapGenePacket(0x09, concatBytes('SnapGene', [0, 1, 0, 15, 0, 19]));

/** A DNA packet: flags byte (0x02 = linear, double-stranded) then the bases. */
export function dnaPacket(seq: string, flags = 0x02): Uint8Array {
  return snapGenePacket(0x00, concatBytes([flags], seq));
}

/**
 * Excerpts of two files of SnapGene's own plasmid library (snapgene.com, "TA and GC cloning
 * vectors"), verbatim apart from display-only attributes (translationMW,
 * consecutiveNumberingStartsFrom) and the gene/product qualifiers. In both files the lacZα CDS
 * has a stale `<Q name="codon_start"><V int="1"/></Q>` next to `readingFrame="±2"`, and the
 * `/translation` SnapGene stored is the frame-2 translation (checked with Biopython on the full
 * files; PlasmidPop issues #153 and #164 report the same on the files bundled with SnapGene 8.2).
 */
export interface LibraryExcerpt {
  /** Bases of the excerpt (DNA packet flags 0x1e in the original files: linear, double-stranded, methylated). */
  seq: string;
  /** The `<Feature>` element, with its range shifted to the excerpt. */
  featureXml: string;
  /** SnapGene's stored /translation without its final '*'. */
  translation: string;
}

/** T-Vector pMD20: bases 1-200; lacZα forward, range 2-194, readingFrame="2", stale /codon_start=1. */
export const PMD20_LACZ: LibraryExcerpt = {
  seq: 'AATCGGATCCCCGGGTACCGAGCTCGAATTCACTGGCCGTCGTTTTACAACGTCGTGACTGGGAAAACCCTGGCGTTACCCAACTTAATCGCCTTGCAGCACATCCCCCTTTCGCCAGCTGGCGTAATAGCGAAGAGGCCCGCACCGATCGCCCTTCCCAACAGTTGCGCAGCCTGAATGGCGAATGGCCCTGATGCGGT',
  featureXml:
    '<Feature recentID="0" name="lacZα" directionality="1" type="CDS" allowSegmentOverlaps="0" readingFrame="2" consecutiveTranslationNumbering="1" hitsStopCodon="1">' +
    '<Segment range="2-194" color="#993366" type="standard" translated="1"/><Q name="codon_start"><V int="1"/></Q><Q name="transl_table"><V int="1"/></Q>' +
    '<Q name="translation"><V text="SDPRVPSSNSLAVVLQRRDWENPGVTQLNRLAAHPPFASWRNSEEARTDRPSQQLRSLNGEWP*"/></Q></Feature>',
  translation: 'SDPRVPSSNSLAVVLQRRDWENPGVTQLNRLAAHPPFASWRNSEEARTDRPSQQLRSLNGEWP',
};

/**
 * T-Vector pMD19 (Simple): bases 2401-2694 (the end of the 2694 bp file); lacZα reverse, range
 * 2408-2693 in the file (8-293 in the excerpt), readingFrame="-2", stale /codon_start=1.
 */
export const PMD19_LACZ: LibraryExcerpt = {
  seq: 'GGCTTAACTATGCGGCATCAGAGCAGATTGTACTGAGAGTGCACCATATGCGGTGTGAAATACCGCACAGATGCGTAAGGAGAAAATACCGCATCAGGCGCCATTCGCCATTCAGGCTGCGCAACTGTTGGGAAGGGCGATCGGTGCGGGCCTCTTCGCTATTACGCCAGCTGGCGAAAGGGGGATGTGCTGCAAGGCGATTAAGTTGGGTAACGCCAGGGTTTTCCCAGTCACGACGTTGTAAAACGACGGCCAGTGAATTAGAACTCGGTACGCGCGGATCTTCCAGAGATT',
  featureXml:
    '<Feature recentID="8" name="lacZα" directionality="2" type="CDS" swappedSegmentNumbering="1" allowSegmentOverlaps="0" readingFrame="-2" consecutiveTranslationNumbering="1" hitsStopCodon="1">' +
    '<Segment range="8-293" color="#993366" type="standard" translated="1"/><Q name="codon_start"><V int="1"/></Q><Q name="transl_table"><V int="1"/></Q>' +
    '<Q name="translation"><V text="SLEDPRVPSSNSLAVVLQRRDWENPGVTQLNRLAAHPPFASWRNSEEARTDRPSQQLRSLNGEWRLMRYFLLTHLCGISHRIWCTLSTICSDAA*"/></Q></Feature>',
  translation: 'SLEDPRVPSSNSLAVVLQRRDWENPGVTQLNRLAAHPPFASWRNSEEARTDRPSQQLRSLNGEWRLMRYFLLTHLCGISHRIWCTLSTICSDAA',
};

/** A SnapGene file holding a library excerpt: cookie, DNA packet (flags 0x1e as in the originals), features. */
export function libraryExcerptFile(excerpt: LibraryExcerpt): Uint8Array {
  return concatBytes(DNA_COOKIE_PACKET, dnaPacket(excerpt.seq, 0x1e), snapGenePacket(0x0a, `<?xml version="1.0"?><Features nextValidID="1">${excerpt.featureXml}</Features>`));
}

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/** Small deterministic PRNG (mulberry32). */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [low, high] (inclusive). */
  int(low: number, high: number): number {
    return low + Math.floor(this.next() * (high - low + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ---------------------------------------------------------------------------
// Record invariants (types.ts)
// ---------------------------------------------------------------------------

function endProblems(end: DnaEnd | undefined, side: string): string[] {
  if (end === undefined) return [`${side} end missing`];
  if (!Number.isInteger(end.length) || end.length < 0) return [`${side} end length ${end.length}`];
  if (end.kind === 'blunt' && end.length !== 0) return [`${side} blunt end with length ${end.length}`];
  if (end.kind !== 'blunt' && end.kind !== '5prime' && end.kind !== '3prime') return [`${side} end kind ${String(end.kind)}`];
  return [];
}

/** Violations of the types.ts conventions in a parsed record (empty when the record is valid). */
export function recordProblems(record: SeqRecord): string[] {
  const problems: string[] = [];
  const L = record.seq.length;
  if (!/^[ACGTRYSWKMBDHVN]*$/.test(record.seq)) problems.push('sequence is not uppercase IUPAC');
  if (record.molecule !== 'DNA') problems.push(`molecule ${record.molecule}`);
  if (record.topology !== 'linear' && record.topology !== 'circular') problems.push(`topology ${String(record.topology)}`);
  const ids = new Set<string>();
  for (const f of record.features) {
    if (ids.has(f.id)) problems.push(`duplicate feature id ${f.id}`);
    ids.add(f.id);
    if (![1, -1, 0].includes(f.strand)) problems.push(`feature ${f.name}: strand ${f.strand}`);
    if (f.segments.length === 0) problems.push(`feature ${f.name}: no segments`);
    if (f.color !== undefined && !/^#[0-9a-f]{6}$/.test(f.color)) problems.push(`feature ${f.name}: colour ${f.color}`);
    if (typeof f.type !== 'string' || f.type === '') problems.push(`feature ${f.name}: type`);
    for (const s of f.segments) {
      const ok =
        Number.isInteger(s.start) &&
        Number.isInteger(s.end) &&
        (record.topology === 'circular' ? s.start >= 0 && s.start < L && s.end > s.start && s.end <= s.start + L : s.start >= 0 && s.end > s.start && s.end <= L);
      if (!ok) problems.push(`feature ${f.name}: segment ${s.start}..${s.end} invalid for ${record.topology} L=${L}`);
    }
    for (const q of f.qualifiers) if (typeof q.key !== 'string' || q.key === '' || (q.value !== null && typeof q.value !== 'string')) problems.push(`feature ${f.name}: qualifier`);
  }
  for (const p of record.primers) {
    if (!/^[ACGTRYSWKMBDHVN]+$/.test(p.sequence)) problems.push(`primer ${p.name}: sequence ${p.sequence}`);
    if (p.name.trim() === '') problems.push('primer without name');
  }
  if (record.ends !== undefined) {
    problems.push(...endProblems(record.ends.left, 'left'), ...endProblems(record.ends.right, 'right'));
    if (record.topology !== 'linear') problems.push('ends on a circular record');
    if (record.ends.left.length + record.ends.right.length >= L) problems.push('ends cover the whole sequence');
  }
  if (record.meta.sourceFormat !== 'snapgene') problems.push('sourceFormat');
  return problems;
}

// ---------------------------------------------------------------------------
// Random records for writer tests
// ---------------------------------------------------------------------------

/**
 * Words for generated text: XML/HTML specials (& < > " '), non-ASCII (BMP and astral), a word
 * that looks like an HTML tag (forces the writer's HTML encoding) and one that only looks like
 * an entity.
 */
const WORDS = [
  'AmpR', 'promoter', 'lac', 'β-lactamase', 'µg/ml', '5′→3′', 'A&B', '<5kb>', 'x>y', '"quoted"', "it's", 'α-helix', '≥', '©',
  'naïve', '🧬', 'T7', 'His6', 'FLAG®', '37°C', '50%', '(+)', '[note]', 'a;b', 'key=value', 'end.', 'HindIII', '&amp;', '<b>bold</b>', 'Ori', '1:2',
];

function words(rng: Rng, low: number, high: number): string {
  const out: string[] = [];
  for (let i = rng.int(low, high); i > 0; i--) out.push(rng.pick(WORDS));
  return out.join(' ');
}

const BASES = 'ACGTACGTACGTACGTRYSWKMBDHVN';

function randomBases(rng: Rng, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += BASES[rng.int(0, BASES.length - 1)];
  return s;
}

/** Ascending, normalized segments (types.ts form), possibly wrapping the origin on circular molecules. */
function randomSegments(rng: Rng, L: number, topology: Topology): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  let position = rng.int(0, L - 1);
  const first = position;
  for (let k = rng.int(1, 4); k > 0; k--) {
    const size = rng.int(1, Math.max(1, Math.min(80, Math.floor(L / 4))));
    const end = position + size;
    if (topology === 'linear' && end > L) break;
    if (end - first > L) break;
    const start = topology === 'circular' ? position % L : position;
    segments.push({ start, end: start + size });
    position = end + (rng.chance(0.3) ? 0 : rng.int(1, 20));
    if (topology === 'linear' && position >= L) break;
  }
  if (segments.length === 0) segments.push({ start: 0, end: Math.min(L, 1) });
  return segments;
}

const FEATURE_TYPES = ['CDS', 'promoter', 'misc_feature', 'terminator', 'rep_origin', 'gene', 'primer_bind', 'protein_bind'];

function randomFeature(rng: Rng, L: number, topology: Topology, index: number): Feature {
  const segments = randomSegments(rng, L, topology);
  const type = rng.pick(FEATURE_TYPES);
  const name = words(rng, 1, 3);
  const strand = rng.pick([1, -1, 0] as const);
  const qualifiers: Qualifier[] = [];
  if (segments.length > 1 && rng.chance(0.3)) qualifiers.push({ key: 'parts', value: `${segments.length}:${rng.pick(['-10', 'signal', 'exon 2'])}` });
  if (rng.chance(0.8)) qualifiers.push({ key: 'label', value: name });
  for (const key of ['note', 'product', 'gene', 'db_xref', 'codon_start', 'transl_table', 'translation', 'pseudo', 'empty']) {
    if (!rng.chance(0.3)) continue;
    const count = key === 'note' ? rng.int(1, 3) : 1;
    for (let i = 0; i < count; i++) {
      let value: string | null;
      if (key === 'codon_start') value = String(rng.int(1, 3));
      else if (key === 'transl_table') value = rng.pick(['1', '11', '01']);
      else if (key === 'db_xref') value = `${rng.pick(['GI', 'GeneID', 'taxon'])}:${rng.int(1, 1e9)}`;
      else if (key === 'translation') value = 'MKV*LLQ'.slice(0, rng.int(1, 6)).replace('*', 'W');
      else if (key === 'pseudo') value = null;
      else if (key === 'empty') value = '';
      else value = words(rng, 1, 6);
      qualifiers.push({ key, value });
    }
  }
  if (!qualifiers.some((q) => q.key === 'label')) qualifiers.push({ key: 'label', value: name });
  return {
    id: `f${index}`,
    type,
    name,
    strand,
    segments,
    qualifiers,
    ...(rng.chance(0.85) ? { color: rng.pick(['#a6acb3', '#ff00aa', '#993366', '#ffffff', '#31849b']) } : {}),
  };
}

function randomPrimer(rng: Rng, index: number): Primer {
  return {
    id: `p${index}`,
    name: words(rng, 1, 2),
    sequence: randomBases(rng, rng.int(12, 40)),
    ...(rng.chance(0.6) ? { description: words(rng, 1, 5) } : {}),
  };
}

/** A random DNA record that the SnapGene writer can store without loss (apart from the documented normalisations). */
export function randomRecord(rng: Rng, index: number): SeqRecord {
  const L = rng.int(rng.chance(0.1) ? 1 : 30, 1200);
  const topology: Topology = rng.chance(0.5) ? 'circular' : 'linear';
  const features: Feature[] = [];
  for (let k = rng.int(0, 8); k > 0; k--) features.push(randomFeature(rng, L, topology, features.length));
  const primers: Primer[] = [];
  for (let k = rng.int(0, 3); k > 0; k--) primers.push(randomPrimer(rng, primers.length));
  let ends: FragmentEnds | undefined;
  if (topology === 'linear' && L > 12 && rng.chance(0.5)) {
    const end = (): DnaEnd => {
      const kind = rng.pick(['blunt', '5prime', '3prime'] as const);
      return kind === 'blunt' ? { kind, length: 0 } : { kind, length: rng.int(1, 5) };
    };
    ends = { left: end(), right: end() };
  }
  const meta: RecordMeta = {};
  if (rng.chance(0.5)) meta.accession = `AB${rng.int(100000, 999999)}`;
  if (rng.chance(0.5)) meta.organism = words(rng, 1, 2);
  if (rng.chance(0.5)) meta.comments = [rng.chance(0.5) ? words(rng, 1, 6) : `${words(rng, 1, 4)}\n${words(rng, 1, 4)}`];
  if (rng.chance(0.3)) meta.division = rng.pick(['SYN', 'BCT', 'PHG']);
  return {
    id: `doc${index}`,
    name: `random record ${index}`,
    description: rng.chance(0.7) ? words(rng, 1, 8) : '',
    seq: randomBases(rng, L),
    topology,
    molecule: 'DNA',
    features,
    primers,
    ...(ends !== undefined ? { ends } : {}),
    meta,
  };
}

// ---------------------------------------------------------------------------
// Expected result of a write -> read round trip
// ---------------------------------------------------------------------------

/** Colours the writer uses for colourless features (copied from snapgene-features.ts; asserted in tests). */
export const WRITER_DEFAULT_COLORS: Readonly<Record<string, string>> = { CDS: '#993366', promoter: '#ffffff', terminator: '#ffffff', rep_origin: '#ffff00' };
export const WRITER_FALLBACK_COLOR = '#a6acb3';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function genBankDate(now: Date): string {
  return `${String(now.getUTCDate()).padStart(2, '0')}-${MONTHS[now.getUTCMonth()]}-${now.getUTCFullYear()}`;
}

/** Qualifiers as the reader returns them after the writer grouped them by key and the reader fixed /label. */
function roundTripQualifiers(feature: Feature): Array<[string, string | null]> {
  const groups = new Map<string, Array<string | null>>();
  for (const q of feature.qualifiers) groups.set(q.key, [...(groups.get(q.key) ?? []), q.value]);
  const out: Array<[string, string | null]> = [];
  for (const [key, values] of groups) {
    const present = values.filter((v) => v !== null);
    if (present.length === 0) out.push([key, null]);
    else for (const v of present) out.push([key, v]);
  }
  const first = out.findIndex(([k]) => k === 'label');
  if (first < 0) out.push(['label', feature.name]);
  else if (out[first][1] !== feature.name) out.splice(first, 0, ['label', feature.name]);
  return out;
}

/**
 * What `parseSnapGene(writeSnapGene(record, { now }), { fileName: record.name + '.dna' })`
 * returns for a record made by {@link randomRecord}, in {@link comparableRecord} shape.
 * `parsedUuid` is the UUID the writer generated (it is derived from a hash).
 */
export function expectedRoundTrip(record: SeqRecord, now: Date, parsedUuid: string): unknown {
  const extras = record.meta.extras ?? {};
  const division = record.meta.division;
  const type = extras.Type ?? (division === undefined || division === 'SYN' ? 'Synthetic' : 'Natural');
  const day = `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.${now.getUTCDate()}`;
  const time = `${now.getUTCHours()}:${now.getUTCMinutes()}:${now.getUTCSeconds()}`;
  const sequenceClass = extras.SequenceClass ?? (division !== undefined && division !== 'SYN' ? division : 'UNA');
  const comments = (record.meta.comments ?? []).filter((c) => c.trim() !== '');
  const meta: RecordMeta = {
    ...(record.meta.accession !== undefined ? { accession: record.meta.accession } : {}),
    ...(record.meta.organism !== undefined ? { organism: record.meta.organism } : {}),
    ...(comments.length > 0 ? { comments: [comments.join('\n')] } : {}),
    division: type === 'Synthetic' ? 'SYN' : sequenceClass,
    date: genBankDate(now),
    sourceFormat: 'snapgene',
    extras: {
      UUID: parsedUuid,
      Type: type,
      ...(type === 'Synthetic' ? { ConfirmedExperimentally: '0' } : {}),
      Created: day,
      'Created.UTC': time,
      LastModified: day,
      'LastModified.UTC': time,
      SequenceClass: sequenceClass,
      TransformedInto: 'unspecified',
      Strandedness: 'double',
      DamMethylated: '0',
      DcmMethylated: '0',
      EcoKIMethylated: '0',
      UpstreamModification: 'Unmodified',
      DownstreamModification: 'Unmodified',
    },
  };
  const ends = record.topology === 'linear' && record.ends !== undefined && (record.ends.left.length > 0 || record.ends.right.length > 0) ? record.ends : undefined;
  return {
    name: record.name,
    description: record.description,
    seq: record.seq,
    topology: record.topology,
    features: record.features.map((f) => ({
      type: f.type,
      name: f.name !== '' ? f.name : featureLabel(f.type, f.qualifiers),
      strand: f.strand,
      segments: f.segments.map((s) => [s.start, s.end]),
      qualifiers: roundTripQualifiers(f),
      color: f.color ?? (Object.hasOwn(WRITER_DEFAULT_COLORS, f.type) ? WRITER_DEFAULT_COLORS[f.type] : WRITER_FALLBACK_COLOR),
    })),
    primers: record.primers.map((p) => ({ name: p.name, sequence: p.sequence, ...(p.description !== undefined ? { description: p.description } : {}) })),
    ...(ends !== undefined ? { ends } : {}),
    meta,
  };
}
