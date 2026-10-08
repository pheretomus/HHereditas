/**
 * Seeded random SeqRecords for the GenBank property tests. Every generated record is in the
 * canonical form our reader produces (single-spaced header text, merged origin crossings,
 * names derived from the qualifiers, comment lines that fit the 68 data columns, ...), so that
 * parseGenbank(writeGenbank(r)) must equal r exactly.
 */
import type { Feature, MoleculeType, Qualifier, Range, RecordMeta, SeqRecord, Strand, Topology } from '../../../src/types';
import { featureLabel, makeRecord } from '../../../src/seq/features';
import { newId } from '../../../src/seq/id';
import { GENBANK_EXTRA_KEYS } from '../../../src/io/genbank';

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Small random-value toolbox on top of a PRNG. */
export class Gen {
  readonly next: () => number;
  constructor(next: () => number) {
    this.next = next;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  word(pool = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', min = 1, max = 10): string {
    const n = min + this.int(max - min + 1);
    let s = '';
    for (let k = 0; k < n; k++) s += pool[this.int(pool.length)];
    return s;
  }
  words(n: number, pool?: string): string {
    return Array.from({ length: n }, () => this.word(pool)).join(' ');
  }
}

/** Free text with the characters that stress quoting and wrapping (no line breaks). */
function qualifierText(g: Gen): string {
  const pieces = ['the', 'quick', '"quoted"', '""', '/path/to', 'a,b', '(x)', 'µg', 'é', 'x'.repeat(70), '  ', '\t', '=', 'end.'];
  const n = g.int(25);
  let s = '';
  for (let k = 0; k < n; k++) s += (k > 0 && g.chance(0.8) ? ' ' : '') + g.pick(pieces);
  return s;
}

function randomSegments(g: Gen, L: number, topology: Topology): Range[] {
  const n = 1 + g.int(3);
  const out: Range[] = [];
  for (let k = 0; k < n; k++) {
    if (g.chance(0.08)) {
      const gap = g.int(topology === 'circular' ? L : L + 1);
      out.push({ start: gap, end: gap });
      continue;
    }
    const start = g.int(L);
    const len = 1 + g.int(topology === 'circular' ? L : L - start);
    out.push({ start, end: start + len });
  }
  // canonical: the parser merges ...L | 0... pieces on circular molecules
  const merged: Range[] = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (
      topology === 'circular' &&
      prev &&
      prev.end === L &&
      s.start === 0 &&
      prev.end > prev.start &&
      s.end > s.start &&
      prev.end - prev.start + s.end <= L
    ) {
      merged[merged.length - 1] = { start: prev.start, end: L + s.end };
    } else merged.push(s);
  }
  return merged;
}

function randomFeature(g: Gen, L: number, topology: Topology, molecule: MoleculeType): Feature {
  const type = g.pick(['CDS', 'gene', 'misc_feature', "5'UTR", 'rep_origin', 'primer_bind', '-10_signal', 'regulatory']);
  const qualifiers: Qualifier[] = [];
  for (let k = g.int(7); k > 0; k--) {
    const key = g.pick(['note', 'gene', 'product', 'label', 'codon_start', 'translation', 'db_xref', 'pseudo', 'transl_table', 'experiment']);
    let value: string | null;
    if (key === 'pseudo') value = null;
    else if (key === 'translation') value = g.word('ACDEFGHIKLMNPQRSTVWY*', 0, 200);
    else if (key === 'codon_start') value = g.pick(['1', '2', '3']);
    else if (key === 'transl_table') value = g.pick(['11', '1', 'Bacterial code 11']);
    else value = g.chance(0.1) ? '' : qualifierText(g);
    qualifiers.push({ key, value });
  }
  const segments = randomSegments(g, L, topology);
  const first = segments[0];
  const last = segments[segments.length - 1];
  const feature: Feature = {
    id: newId('f'),
    type,
    name: featureLabel(type, qualifiers),
    strand: molecule === 'protein' ? 0 : (g.pick([1, -1]) as Strand),
    segments,
    qualifiers,
  };
  if (first.end > first.start && g.chance(0.2)) feature.partialStart = true;
  if (last.end > last.start && g.chance(0.2)) feature.partialEnd = true;
  const color = () => '#' + g.word('0123456789abcdef', 6, 6);
  if (g.chance(0.3)) feature.color = color();
  if (g.chance(0.15)) {
    const rev = color();
    if (rev !== feature.color) feature.reverseColor = rev;
  }
  return feature;
}

/** A random record in canonical form; `maxNameLength` bounds the LOCUS name (GenBank column: 16). */
export function randomRecord(g: Gen, date: string, maxNameLength = 24): SeqRecord {
  const molecule = g.pick<MoleculeType>(['DNA', 'DNA', 'DNA', 'RNA', 'protein']);
  const alphabet = molecule === 'DNA' ? 'ACGTACGTACGTRYSWKMBDHVN' : molecule === 'RNA' ? 'ACGUACGUN' : 'ACDEFGHIKLMNPQRSTVWYX*';
  const seq = g.word(alphabet, 0, 1500);
  const topology = g.pick<Topology>(['linear', 'circular']);
  const tokens: Record<MoleculeType, string[]> = { DNA: ['DNA', 'ds-DNA', 'mRNA', 'ss-DNA'], RNA: ['RNA', 'ss-RNA', 'cRNA'], protein: [] };
  const meta: RecordMeta = { sourceFormat: 'genbank', date, division: g.pick(['SYN', 'BCT', 'PRI', 'UNK']) };
  if (molecule !== 'protein') meta.extras = { [GENBANK_EXTRA_KEYS.moleculeType]: g.pick(tokens[molecule]) };
  if (g.chance(0.5)) meta.accession = g.words(1 + g.int(20));
  if (g.chance(0.5)) meta.version = g.chance(0.5) ? 'X1.2' : 'X1.2 GI:12345';
  if (g.chance(0.5)) meta.keywords = g.words(1 + g.int(30)) + (g.chance(0.3) ? '.' : '');
  if (g.chance(0.5)) meta.source = g.words(1 + g.int(20));
  if (g.chance(0.5)) meta.organism = g.words(1 + g.int(20), 'abcdefghij');
  if (g.chance(0.5)) {
    const lineage = Array.from({ length: 2 + g.int(12) }, () => g.word()).join('; ') + '.';
    meta.extras = { ...meta.extras, [GENBANK_EXTRA_KEYS.taxonomy]: lineage };
  }
  if (g.chance(0.5)) {
    // comment lines longer than the 68 data columns are re-wrapped by design: stay within them
    meta.comments = Array.from({ length: 1 + g.int(3) }, () =>
      Array.from({ length: 1 + g.int(4) }, (_, k) =>
        k > 0 && g.chance(0.2) ? '' : (g.chance(0.2) ? '  ' : '') + g.words(1 + g.int(5)),
      )
        .join('\n')
        .replace(/\n+$/, ''), // trailing blank comment lines are not kept by the reader
    );
  }
  if (g.chance(0.4)) {
    meta.extraHeaderLines = [
      'DBLINK      BioProject: PRJNA' + g.int(1000),
      'REFERENCE   1  (bases 1 to 10)',
      '  AUTHORS   ' + g.words(3),
      '            ' + g.words(4),
      '  TITLE     Direct Submission',
    ];
  }
  const description = g.chance(0.8) ? g.words(1 + g.int(30)) + (g.chance(0.2) ? '.' : '') : '';
  const features = seq.length === 0 ? [] : Array.from({ length: g.int(9) }, () => randomFeature(g, seq.length, topology, molecule));
  return makeRecord({ name: g.word(undefined, 1, maxNameLength), description, seq, topology, molecule, features, meta });
}
