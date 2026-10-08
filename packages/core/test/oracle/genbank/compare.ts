/**
 * Helpers for the GenBank differential tests: a canonical, comparable view of a record built
 * either from our parse (SeqRecord) or from Biopython's parse (JSON written by
 * tools/oracle/genbank_oracle.py), and a comparator that reports differences as text.
 *
 * The canonical view removes representation differences that are not disagreements:
 *  - Biopython keeps origin-spanning locations as two parts; we merge them into one segment
 *    with end > L. Canonical locations are in our model (top-strand order, merged).
 *  - Biopython stores qualifiers in a dict (key -> list of values) and turns value-less
 *    qualifiers into "" (skipping repeats); our list is converted the same way.
 *  - Remote parts (AB123.1:1..10) are dropped on both sides; join/order/bond operators are not
 *    compared (our model has no operator).
 *  - Biopython has no topology when the LOCUS line has none; we read it as linear.
 * Everything else must match, except the per-feature deviations listed by the tests.
 */
import type { Qualifier, Range, SeqRecord } from '../../../src/types';
import { GENBANK_EXTRA_KEYS } from '../../../src/io/genbank';
import { moleculeTypeOfToken } from '../../../src/io/genbank-locus';

// ---------------------------------------------------------------------------
// Oracle JSON (see tools/oracle/genbank_oracle.py)
// ---------------------------------------------------------------------------

export interface OraclePart {
  start: number;
  end: number;
  strand: number | null;
  ref: string | null;
  startKind: string;
  endKind: string;
}

export interface OracleLocation {
  operator: string | null;
  strand: number | null;
  parts: OraclePart[];
}

export interface OracleFeature {
  type: string;
  location: OracleLocation | null;
  qualifiers: [string, string][];
}

export interface OracleReference {
  location: [number, number][];
  authors: string;
  consrtm: string;
  title: string;
  journal: string;
  medline: string;
  pubmed: string;
  comment: string;
}

export interface OracleRecord {
  name: string;
  id: string;
  description: string;
  seqDefined: boolean;
  seqLength: number;
  seqSha1: string | null;
  seq: string | null;
  topology: string | null;
  moleculeType: string | null;
  division: string | null;
  date: string | null;
  accessions: string[] | null;
  sequenceVersion: number | null;
  gi: string | null;
  keywords: string[] | null;
  source: string | null;
  organism: string | null;
  taxonomy: string[] | null;
  comment: string | null;
  structuredComment: Record<string, Record<string, string>> | null;
  dbxrefs: string[];
  references: OracleReference[];
  contig: string | null;
  segment: string | null;
  dbSource: string | null;
  featureCount: number;
  features?: OracleFeature[];
  typeCounts?: Record<string, number>;
  compactFeatures?: [string, string, string, number][];
}

export interface OracleFile {
  file: string;
  biopython: string;
  error: string | null;
  warnings: string[];
  records: OracleRecord[];
}

// ---------------------------------------------------------------------------
// Canonical view
// ---------------------------------------------------------------------------

export interface CanonicalLocation {
  strand: number;
  segments: Range[];
  partialStart: boolean;
  partialEnd: boolean;
  /** Parts on both strands (Biopython keeps them; we store the majority strand). */
  mixedStrands?: boolean;
}

export interface CanonicalFeature {
  type: string;
  /** null: Biopython could not parse the location. */
  location: CanonicalLocation | null;
  qualifiers: [string, string][];
}

export interface CanonicalRecord {
  name: string;
  description: string;
  /** The sequence, or `undefined:<length>` for Biopython's undefined (CONTIG / missing) sequences. */
  seq: string;
  topology: string;
  moleculeType: string | null;
  division: string | null;
  date: string | null;
  accessions: string[];
  /** Version number n of the VERSION line `ACCESSION.n`, or null. */
  version: number | null;
  gi: string | null;
  keywords: string[];
  source: string;
  organism: string | null;
  taxonomy: string[];
  /** Plain COMMENT lines (structured-comment tables removed), empty lines dropped. */
  commentLines: string[];
  structuredComment: Record<string, Record<string, string>>;
  features: CanonicalFeature[];
}

const ws = (s: string): string => s.replace(/\s+/g, ' ').trim();
const APE_KEYS = new Set(['apeinfo_fwdcolor', 'apeinfo_revcolor', 'apeinfo_graphicformat']);

/** Qualifiers as Biopython's ordered dict, flattened (value-less repeats are skipped, null -> ""). */
export function biopythonQualifiers(qualifiers: readonly Qualifier[]): [string, string][] {
  const dict = new Map<string, string[]>();
  for (const q of qualifiers) {
    const values = dict.get(q.key);
    if (q.value === null) {
      if (values === undefined) dict.set(q.key, ['']);
    } else if (values === undefined) dict.set(q.key, [q.value]);
    else values.push(q.value);
  }
  const out: [string, string][] = [];
  for (const [key, values] of dict) for (const v of values) out.push([key, v]);
  return out;
}

/** Merge `...L` + `0...` pieces into one wrapping segment, like our location parser. */
function mergeOrigin(segments: Range[], L: number): Range[] {
  const out: Range[] = [];
  for (const s of segments) {
    const prev = out[out.length - 1];
    if (prev && prev.end === L && s.start === 0 && prev.end > prev.start && s.end > s.start && prev.end - prev.start + s.end <= L) {
      out[out.length - 1] = { start: prev.start, end: L + s.end };
    } else out.push({ ...s });
  }
  return out;
}

const isFuzzy = (kind: string) => kind === 'before' || kind === 'after';

/** Biopython location -> our model (top-strand order, merged origin crossings, refs dropped). */
export function canonicalFromOracleLocation(
  loc: OracleLocation | null,
  L: number,
  circular: boolean,
  protein: boolean,
): CanonicalLocation | null {
  if (loc === null) return null;
  const parts = loc.parts.filter((p) => p.ref === null);
  if (parts.length === 0) return null;
  const strands = new Set(parts.map((p) => p.strand ?? 0));
  const allMinus = strands.size === 1 && strands.has(-1);
  const top = allMinus ? [...parts].reverse() : parts;
  // Biopython keeps the origin site "L^1" of a circular molecule as (L, L); our gap is 0.
  let segments = top.map((p) => (circular && p.start === L && p.end === L ? { start: 0, end: 0 } : { start: p.start, end: p.end }));
  if (circular && L > 0) segments = mergeOrigin(segments, L);
  const out: CanonicalLocation = {
    strand: protein ? 0 : allMinus ? -1 : strands.has(-1) ? NaN : 1,
    segments,
    partialStart: isFuzzy(top[0].startKind),
    partialEnd: isFuzzy(top[top.length - 1].endKind),
  };
  if (strands.size > 1) out.mixedStrands = true;
  return out;
}

/** Biopython's _split_taxonomy. */
function splitTaxonomy(text: string | undefined): string[] {
  if (!text || text === '.') return [];
  const body = text.endsWith('.') ? text.slice(0, -1) : text;
  return body
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Split COMMENT lines into plain lines and structured-comment tables the way Biopython 1.88
 * does (`##Name-START##`, `key :: value`, `##Name-END##`).
 */
function splitStructuredComments(comments: readonly string[]) {
  const plain: string[] = [];
  const structured: Record<string, Record<string, string>> = {};
  for (const comment of comments) {
    let key: string | null = null;
    let lastSub: string | null = null;
    for (const line of comment.split('\n')) {
      const start = /([^#]+)-START##$/.exec(line);
      if (start) {
        key = start[1];
        continue;
      }
      if (key !== null && line.includes('-END##')) {
        key = null;
        continue;
      }
      if (key !== null && line.includes('::')) {
        const m = /(.+?)\s*::\s*(.*)/.exec(line);
        if (m) {
          (structured[key] ??= {})[m[1]] = m[2];
          lastSub = m[1];
        }
        continue;
      }
      if (key !== null && lastSub !== null) {
        structured[key][lastSub] += ' ' + line.trim();
        continue;
      }
      plain.push(line);
    }
  }
  return { plain: plain.filter((l) => l.trim() !== ''), structured };
}

/** Canonical view of a record parsed by our reader. */
export function canonicalFromOurs(r: SeqRecord): CanonicalRecord {
  const meta = r.meta;
  const protein = r.molecule === 'protein';
  const comments = splitStructuredComments(meta.comments ?? []);
  // Biopython adds the accession of the VERSION line to the accession list and keeps only n.
  const version = /^(\S+)\.(\d+)$/.exec(meta.version?.split(/\s+/)[0] ?? '');
  const gi = /GI:(\d+)/.exec(meta.version ?? '');
  const accessions = meta.accession ? meta.accession.split(/[\s;]+/).filter((a) => a !== '') : [];
  if (version && !accessions.includes(version[1])) accessions.push(version[1]);
  const source = meta.source ?? '';
  return {
    name: r.name,
    description: ws(r.description),
    seq: r.seq,
    topology: r.topology,
    moleculeType: meta.extras?.[GENBANK_EXTRA_KEYS.moleculeType] ?? (protein ? 'protein' : null),
    division: meta.division ?? null,
    date: meta.date ?? null,
    accessions,
    version: version ? Number(version[2]) : null,
    gi: gi ? gi[1] : null,
    // our keywords already lack the syntactic final period that Biopython strips
    keywords: meta.keywords ? meta.keywords.split(';').map((k) => k.trim()) : [''],
    source: ws(source.endsWith('.') ? source.slice(0, -1) : source),
    organism: meta.organism ? ws(meta.organism) : null,
    taxonomy: splitTaxonomy(meta.extras?.[GENBANK_EXTRA_KEYS.taxonomy]),
    commentLines: comments.plain,
    structuredComment: comments.structured,
    features: r.features.map((f) => ({
      type: f.type,
      location: {
        strand: f.strand,
        segments: f.segments.map((s) => ({ start: s.start, end: s.end })),
        partialStart: f.partialStart === true,
        partialEnd: f.partialEnd === true,
      },
      qualifiers: biopythonQualifiers(f.qualifiers),
    })),
  };
}

/** Canonical view of a record parsed by Biopython. */
export function canonicalFromOracle(r: OracleRecord): CanonicalRecord {
  const protein = r.moleculeType === 'protein';
  const circular = r.topology === 'circular';
  const accessions = (r.accessions ?? []).filter((a) => a !== '.');
  return {
    name: r.name,
    description: ws(r.description),
    seq: r.seqDefined ? (r.seq ?? `sha1:${r.seqSha1}`) : `undefined:${r.seqLength}`,
    topology: r.topology ?? 'linear',
    moleculeType: r.moleculeType,
    // Biopython's old-layout LOCUS branch stores blank columns 53-55 as a "   " division.
    division: r.division !== null && r.division.trim() !== '' ? r.division : null,
    date: r.date,
    accessions,
    version: r.sequenceVersion,
    gi: r.gi,
    keywords: r.keywords ?? [''],
    source: ws(r.source ?? ''),
    organism: r.organism && r.organism !== '.' ? ws(r.organism) : null,
    taxonomy: r.taxonomy ?? [],
    commentLines: (r.comment ?? '').split('\n').filter((l) => l.trim() !== ''),
    structuredComment: r.structuredComment ?? {},
    features: (r.features ?? []).map((f) => ({
      type: f.type,
      location: canonicalFromOracleLocation(f.location, r.seqLength, circular, protein),
      qualifiers: f.qualifiers.filter(([k]) => !APE_KEYS.has(k.toLowerCase())),
    })),
  };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** A documented, deliberate difference between our reader and Biopython for one feature. */
export interface FeatureDeviation {
  file: string;
  record: number;
  /** Index of the feature in Biopython's (oracle) feature list. */
  feature: number;
  /** Why we differ. */
  reason: string;
  /** 'dropped': we do not keep the feature; 'location': we keep it with `expected` as location. */
  kind: 'dropped' | 'location';
  expected?: CanonicalLocation;
}

const show = (v: unknown) => JSON.stringify(v);

/**
 * Differences between the oracle's view (`expected`) and the view under test (`actual`),
 * honouring the documented feature deviations of this record. Empty when they agree.
 */
export function diffRecords(
  expected: CanonicalRecord,
  actual: CanonicalRecord,
  deviations: readonly FeatureDeviation[] = [],
  options: { compareMoleculeToken?: boolean } = {},
): string[] {
  const diffs: string[] = [];
  const check = (what: string, e: unknown, a: unknown) => {
    if (show(e) !== show(a)) diffs.push(`${what}: expected ${show(e)}, got ${show(a)}`);
  };
  check('name', expected.name, actual.name);
  check('description', expected.description, actual.description);
  const undefinedSeq = /^undefined:(\d+)$/.exec(expected.seq);
  if (undefinedSeq) {
    // Biopython keeps CONTIG / missing sequences undefined; we use an N (protein: X) placeholder.
    const n = Number(undefinedSeq[1]);
    const placeholder = expected.moleculeType === 'protein' ? 'X' : 'N';
    if (actual.seq !== expected.seq && actual.seq !== placeholder.repeat(n)) diffs.push(`seq: expected ${n} placeholders`);
  } else if (expected.seq !== actual.seq) {
    diffs.push(`seq: differs (expected length ${expected.seq.length}, got ${actual.seq.length})`);
  }
  check('topology', expected.topology, actual.topology);
  const category = (t: string | null) => (t === null ? null : (moleculeTypeOfToken(t) ?? t));
  if (options.compareMoleculeToken === false) {
    check('molecule category', category(expected.moleculeType), category(actual.moleculeType));
  } else {
    check('moleculeType', expected.moleculeType, actual.moleculeType);
  }
  check('division', expected.division, actual.division);
  check('date', expected.date, actual.date);
  check('accessions', expected.accessions, actual.accessions);
  check('version', expected.version, actual.version);
  check('gi', expected.gi, actual.gi);
  check('keywords', expected.keywords, actual.keywords);
  check('source', expected.source, actual.source);
  check('organism', expected.organism, actual.organism);
  check('taxonomy', expected.taxonomy, actual.taxonomy);
  check('comment', expected.commentLines, actual.commentLines);
  check('structuredComment', expected.structuredComment, actual.structuredComment);

  let k = 0;
  expected.features.forEach((ef, index) => {
    const deviation = deviations.find((d) => d.feature === index);
    if (deviation?.kind === 'dropped') return;
    const af = actual.features[k++];
    const where = `feature #${index} (${ef.type})`;
    if (af === undefined) {
      diffs.push(`${where}: missing`);
      return;
    }
    check(`${where} type`, ef.type, af.type);
    check(`${where} qualifiers`, ef.qualifiers, af.qualifiers);
    const expectedLocation = deviation?.kind === 'location' ? deviation.expected : ef.location;
    if (expectedLocation === null || expectedLocation === undefined || expectedLocation.mixedStrands) {
      diffs.push(`${where}: oracle location ${show(ef.location)} needs a documented deviation; got ${show(af.location)}`);
    } else {
      check(`${where} location`, expectedLocation, af.location);
    }
  });
  if (k !== actual.features.length) diffs.push(`features: ${actual.features.length - k} unexpected extra feature(s)`);
  for (const d of deviations) {
    if (d.feature >= expected.features.length) diffs.push(`deviation for missing feature #${d.feature}`);
  }
  return diffs;
}
