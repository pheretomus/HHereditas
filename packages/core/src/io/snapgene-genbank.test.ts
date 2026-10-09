/**
 * Integration with the GenBank reader and writer of this package:
 *  - GenBank records saved as SnapGene files and read back. Checks that nothing is lost silently:
 *    everything the writer keeps (features, metadata) reads back identically, and every feature,
 *    segment, reverse colour or metadata field it drops is reported in a warning. Uses every GenBank
 *    fixture, plus the 11.7 MB E. coli genome when it is present (it is gitignored).
 *  - SnapGene records exported as GenBank keep the reading frame SnapGene translates in.
 * Skipped when the GenBank reader / writer is not available.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { featureLabel } from '../seq/features';
import { normalizeRange } from '../seq/range';
import { translateFeature } from '../seq/translate';
import type { Feature, Range, SeqRecord } from '../types';
import type { ParseResult } from './types';
import { parseSnapGene, writeSnapGeneWithWarnings } from './snapgene';
import { looksLikeHtml } from './snapgene-markup';
import { CORE_DIR, PMD19_LACZ, PMD20_LACZ, libraryExcerptFile, recordProblems } from '../../test/oracle/snapgene/testkit';

type GenbankReader = (text: string) => ParseResult;

async function loadGenbankReader(): Promise<GenbankReader | undefined> {
  try {
    const module = (await import('./genbank')) as { parseGenbank?: unknown };
    return typeof module.parseGenbank === 'function' ? (module.parseGenbank as GenbankReader) : undefined;
  } catch {
    return undefined;
  }
}

const GENBANK_DIR = join(CORE_DIR, 'test', 'fixtures', 'genbank');
const ECOLI = join(CORE_DIR, 'test', 'fixtures', 'large', 'ecoli_U00096.3.gb');
const NOW = new Date(Date.UTC(2026, 9, 8));

/** The writer's notion of a storable segment (types.ts normalized form). */
function writableSegment(s: Range, L: number, circular: boolean): Range | undefined {
  if (!Number.isInteger(s.start) || !Number.isInteger(s.end)) return undefined;
  if (circular && L > 0) {
    const n = normalizeRange(s, L, 'circular');
    return n.end > n.start ? n : undefined;
  }
  return s.start >= 0 && s.end <= L && s.start < s.end ? { start: s.start, end: s.end } : undefined;
}

/** A qualifier value as the SnapGene reader returns it (single line, see richTextToPlain). */
function readBackValue(key: string, value: string | null): string | null {
  if (value === null) return null;
  let v = looksLikeHtml(value) ? value.replace(/\s+/g, ' ').trim() : value.replace(/\r\n|\r|\n/g, ' ').trim();
  if (key === 'translation') v = v.replace(/,/g, '').replace(/\*$/, '').replace(/\?/g, 'X');
  return v;
}

/** Qualifiers as written (grouped by key, value-less entries dropped next to values) and read back (first /label = name). */
function expectedQualifiers(feature: Feature, name: string): Array<[string, string | null]> {
  const groups = new Map<string, Array<string | null>>();
  for (const q of feature.qualifiers) {
    if (q.key.trim() === '') continue;
    groups.set(q.key, [...(groups.get(q.key) ?? []), q.value]);
  }
  const out: Array<[string, string | null]> = [];
  for (const [key, values] of groups) {
    const present = values.filter((v) => v !== null);
    if (present.length === 0) out.push([key.trim(), null]);
    else for (const v of present) out.push([key.trim(), readBackValue(key, v)]);
  }
  const first = out.findIndex(([k]) => k === 'label');
  if (first < 0) out.push(['label', name]);
  else if (out[first][1] !== name) out.splice(first, 0, ['label', name]);
  return out;
}

function checkRecord(record: SeqRecord, label: string): { features: number; dropped: number; warnings: number } {
  const L = record.seq.length;
  const circular = record.topology === 'circular';
  const { data, warnings } = writeSnapGeneWithWarnings(record, { now: NOW });
  const result = parseSnapGene(data, { fileName: `${record.name}.dna` });
  expect(result.warnings, label).toEqual([]);
  expect(result.records, label).toHaveLength(1);
  const back = result.records[0];
  expect(recordProblems(back), label).toEqual([]);
  expect(back.seq, label).toBe(record.seq);
  expect(back.topology, label).toBe(record.topology);
  expect(back.description, label).toBe(record.description.replace(/\r\n|\r|\n/g, ' ').trim());

  const kept = record.features.filter((f) => f.segments.some((s) => writableSegment(s, L, circular) !== undefined));
  const dropped = record.features.length - kept.length;
  expect(back.features.length, label).toBe(kept.length);
  expect(warnings.filter((w) => w.message.includes('feature not written')).length, `${label}: every dropped feature is reported`).toBe(dropped);
  kept.forEach((f, i) => {
    const got = back.features[i];
    const where = `${label} feature ${i} (${f.type} ${f.name})`;
    const segments = f.segments.map((s) => writableSegment(s, L, circular)).filter((s): s is Range => s !== undefined);
    if (segments.length < f.segments.length) expect(warnings.some((w) => /^Feature ".*": segment .*; not written\.$/.test(w.message)), where).toBe(true);
    const name = f.name.trim() !== '' ? f.name.replace(/\r\n|\r|\n/g, ' ').trim() : featureLabel(f.type, f.qualifiers);
    expect(got.type, where).toBe(f.type.trim() !== '' ? f.type : 'misc_feature');
    expect(got.strand, where).toBe(f.strand);
    expect(got.segments, where).toEqual(segments);
    expect(got.name, where).toBe(name);
    expect(got.qualifiers.map((q) => [q.key, q.value]), where).toEqual(expectedQualifiers(f, name));
    if (f.color !== undefined && /^#[0-9a-f]{6}$/i.test(f.color)) expect(got.color, where).toBe(f.color.toLowerCase());
  });
  if (record.features.some((f) => f.partialStart === true || f.partialEnd === true)) {
    expect(warnings.some((w) => w.message.includes('partial (fuzzy) ends')), label).toBe(true);
  }
  const reverseColors = kept.filter((f, i) => f.reverseColor !== undefined && f.reverseColor.toLowerCase() !== back.features[i].color).length;
  expect(warnings.some((w) => w.message.startsWith(`${reverseColors} feature(s) have a reverse colour`)), label).toBe(reverseColors > 0);
  checkMeta(record, back, warnings.map((w) => w.message), label);
  return { features: kept.length, dropped, warnings: warnings.length };
}

/** Text as the SnapGene reader returns a one-line field (line breaks become spaces, ends trimmed); undefined when blank. */
function oneLine(value: string | undefined): string | undefined {
  const text = value?.replace(/\r\n|\r|\n/g, ' ').trim();
  return text === '' ? undefined : text;
}

/** Metadata (reviewed defect: never compared): what a SnapGene file stores reads back, the rest is reported. */
function checkMeta(record: SeqRecord, back: SeqRecord, messages: string[], label: string): void {
  const meta = record.meta;
  expect(back.meta.accession, label).toBe(oneLine(meta.accession));
  expect(back.meta.organism, label).toBe(oneLine(meta.organism));
  const division = meta.division?.trim().toUpperCase();
  if (division !== undefined && /^[A-Z]{3}$/.test(division)) expect(back.meta.division, label).toBe(division);
  // Several comments become one; multi-line comments are stored as HTML, whose spacing is not kept.
  const words = (texts: readonly string[] | undefined) => (texts ?? []).join(' ').split(/\s+/).filter((w) => w !== '');
  expect(words(back.meta.comments), label).toEqual(words(meta.comments));
  // ...and when that changes their spacing (double spaces, aligned columns), it is reported (verification defect: silent).
  const comments = (meta.comments ?? []).filter((c) => c.trim() !== '').join('\n').replace(/\r\n?/g, '\n').trim();
  if ((back.meta.comments ?? []).join('\n') !== comments) {
    expect(messages.some((m) => m.includes(' text value(s) lose line breaks or spacing in the SnapGene file')), `${label}: comment spacing`).toBe(true);
  }
  const reported = (prefix: string) => messages.some((m) => m.startsWith(prefix));
  expect(reported('The sequence version '), `${label}: VERSION`).toBe(oneLine(meta.version) !== undefined);
  expect(reported('The keywords '), `${label}: KEYWORDS`).toBe(oneLine(meta.keywords) !== undefined);
  expect(reported('The source '), `${label}: SOURCE`).toBe(oneLine(meta.source) !== undefined);
  const headerLines = (meta.extraHeaderLines ?? []).filter((line) => line.trim() !== '').length;
  expect(reported(`${headerLines} GenBank header line(s)`), `${label}: other header lines`).toBe(headerLines > 0);
  const genbankExtras = Object.keys(meta.extras ?? {});
  expect(reported(`${genbankExtras.length} field(s) of meta.extras were not written`), `${label}: extras`).toBe(genbankExtras.length > 0);
  for (const key of genbankExtras.slice(0, 5)) expect(messages.join('\n'), label).toContain(`"${key}"`);
}

type GenbankWriter = (record: SeqRecord) => string;

async function loadGenbankWriter(): Promise<GenbankWriter | undefined> {
  try {
    const module = (await import('./genbank')) as { writeGenbank?: unknown };
    return typeof module.writeGenbank === 'function' ? (module.writeGenbank as GenbankWriter) : undefined;
  } catch {
    return undefined;
  }
}

describe('SnapGene -> GenBank', async () => {
  const writeGenbank = await loadGenbankWriter();

  it.skipIf(writeGenbank === undefined)('exports the reading frame SnapGene translates in, not a stale /codon_start (reviewed defect, T-Vector pMD20 / pMD19 lacZα)', () => {
    if (writeGenbank === undefined) return;
    for (const excerpt of [PMD20_LACZ, PMD19_LACZ]) {
      const record = parseSnapGene(libraryExcerptFile(excerpt), { fileName: 'library.dna' }).records[0];
      const text = writeGenbank(record);
      expect(text).toContain('/codon_start=2');
      expect(text).not.toContain('/codon_start=1');
      // The exported frame gives SnapGene's own /translation (HHereditas' translation engine, standard code).
      expect(translateFeature(record, record.features[0], { toStop: true })).toBe(excerpt.translation);
    }
  });
});

describe('GenBank -> SnapGene -> record', async () => {
  const parseGenbank = await loadGenbankReader();

  it.skipIf(parseGenbank === undefined)('keeps everything it writes and reports everything it drops (all GenBank fixtures)', () => {
    if (parseGenbank === undefined) return;
    let records = 0;
    for (const name of readdirSync(GENBANK_DIR).filter((n) => /\.gbk?$/.test(n))) {
      const parsed = parseGenbank(readFileSync(join(GENBANK_DIR, name), 'utf8'));
      for (const [index, record] of parsed.records.entries()) {
        if (record.molecule !== 'DNA' || !/^[ACGTRYSWKMBDHVN]*$/.test(record.seq)) continue;
        checkRecord(record, `${name}#${index}`);
        records++;
      }
    }
    expect(records).toBeGreaterThan(20);
  });

  it.skipIf(parseGenbank === undefined || !existsSync(ECOLI))(
    'round-trips the E. coli K-12 genome (U00096.3, 4.6 Mb)',
    () => {
      if (parseGenbank === undefined) return;
      const record = parseGenbank(readFileSync(ECOLI, 'utf8')).records[0];
      const started = Date.now();
      const stats = checkRecord(record, 'U00096.3');
      console.info('E. coli U00096.3 via SnapGene:', JSON.stringify({ length: record.seq.length, ...stats, ms: Date.now() - started }));
      expect(stats.features).toBeGreaterThan(4000);
      expect(Date.now() - started).toBeLessThan(60000);
    },
    180000,
  );
});
