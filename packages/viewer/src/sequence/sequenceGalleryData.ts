/**
 * Demo data for the SequenceView gallery (development only): naive enzyme / primer / ORF /
 * motif finders, a synthetic 4.6 Mb genome and a naive edit applier. Real analyses come from
 * @hhereditas/core; these exist so the gallery does not depend on unfinished core modules.
 */
import type { EnzymeSite, Feature, Orf, Primer, PrimerBindingSite, SearchHit, SeqRecord } from '@hhereditas/core';
import { reverseComplement } from '@hhereditas/core';
import type { SequenceEdit } from './types';

interface DemoEnzyme {
  name: string;
  site: string;
  /** Top / bottom cut offsets from the start of the site (top-strand coordinates). */
  top: number;
  bottom: number;
}

export const DEMO_ENZYMES: readonly DemoEnzyme[] = [
  { name: 'EcoRI', site: 'GAATTC', top: 1, bottom: 5 },
  { name: 'BamHI', site: 'GGATCC', top: 1, bottom: 5 },
  { name: 'HindIII', site: 'AAGCTT', top: 1, bottom: 5 },
  { name: 'NotI', site: 'GCGGCCGC', top: 2, bottom: 6 },
  { name: 'XhoI', site: 'CTCGAG', top: 1, bottom: 5 },
  { name: 'NdeI', site: 'CATATG', top: 2, bottom: 4 },
  { name: 'KpnI', site: 'GGTACC', top: 5, bottom: 1 },
  { name: 'PstI', site: 'CTGCAG', top: 5, bottom: 1 },
  { name: 'EcoRV', site: 'GATATC', top: 3, bottom: 3 },
  { name: 'SacI', site: 'GAGCTC', top: 5, bottom: 1 },
];

/** Palindromic demo enzymes found by plain string search (circular-aware). */
export function findDemoSites(seq: string, circular: boolean, enzymes: readonly DemoEnzyme[] = DEMO_ENZYMES): EnzymeSite[] {
  const L = seq.length;
  const sites: EnzymeSite[] = [];
  for (const e of enzymes) {
    const k = e.site.length;
    const text = circular && L >= k ? seq + seq.slice(0, k - 1) : seq;
    let i = text.indexOf(e.site);
    while (i >= 0 && i < L) {
      const top = (i + e.top) % (L || 1);
      const bottom = (i + e.bottom) % (L || 1);
      sites.push({ enzyme: e.name, range: { start: i, end: i + k }, strand: 1, cuts: [{ top, bottom }] });
      i = text.indexOf(e.site, i + 1);
    }
  }
  sites.sort((a, b) => a.range.start - b.range.start);
  return sites;
}

/** Exact motif hits on both strands. */
export function findMotif(seq: string, motif: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const rc = reverseComplement(motif);
  for (const [m, strand] of [[motif, 1], [rc, -1]] as const) {
    if (strand === -1 && rc === motif) continue;
    let i = seq.indexOf(m);
    while (i >= 0) {
      hits.push({ range: { start: i, end: i + m.length }, strand, mismatches: 0 });
      i = seq.indexOf(m, i + 1);
    }
  }
  return hits.sort((a, b) => a.range.start - b.range.start);
}

const STOPS = new Set(['TAA', 'TAG', 'TGA']);

/** ATG..stop ORFs of at least `minAa` codons in the six frames (no wrapping). */
export function findDemoOrfs(seq: string, minAa = 150): Orf[] {
  const out: Orf[] = [];
  const L = seq.length;
  for (const strand of [1, -1] as const) {
    const s = strand === 1 ? seq : reverseComplement(seq);
    for (let frame = 0; frame < 3; frame++) {
      let start = -1;
      for (let i = frame; i + 3 <= L; i += 3) {
        const codon = s.slice(i, i + 3);
        if (start < 0 && codon === 'ATG') start = i;
        else if (start >= 0 && STOPS.has(codon)) {
          const aa = (i - start) / 3;
          if (aa >= minAa) {
            const range = strand === 1 ? { start, end: i + 3 } : { start: L - (i + 3), end: L - start };
            out.push({ range, strand, frame: frame as 0 | 1 | 2, aaLength: aa, hasStop: true });
          }
          start = -1;
        }
      }
    }
  }
  return out.sort((a, b) => a.range.start - b.range.start);
}

/** Demo primers on a record: binding sites built by construction (tails, mismatches, a wrap). */
export function demoPrimersFor(record: SeqRecord): { record: SeqRecord; primerSites: PrimerBindingSite[] } {
  const seq = record.seq;
  const L = seq.length;
  const circular = record.topology === 'circular';
  const primers: Primer[] = [];
  const sites: PrimerBindingSite[] = [];
  const add = (
    id: string,
    name: string,
    strand: 1 | -1,
    start: number,
    length: number,
    tail = '',
    mismatchAt: number[] = [],
  ) => {
    const end = start + length;
    const template = end <= L ? seq.slice(start, end) : seq.slice(start) + seq.slice(0, end - L);
    let annealed = strand === 1 ? template : reverseComplement(template);
    for (const at of mismatchAt) {
      const b = annealed[at];
      annealed = annealed.slice(0, at) + (b === 'A' ? 'C' : b === 'C' ? 'G' : b === 'G' ? 'T' : 'A') + annealed.slice(at + 1);
    }
    primers.push({ id, name, sequence: tail + annealed });
    sites.push({
      primerId: id,
      strand,
      range: { start, end },
      annealedLength: length,
      mismatches: mismatchAt.length,
      tailLength: tail.length,
      tm: 58 + ((start * 7) % 60) / 10,
    });
  };
  add('p1', 'KanMX-F', 1, Math.min(470, L - 30), 22, 'GATCGGATCC', [4]);
  add('p2', 'TEF-R', -1, Math.min(392, L - 30), 21);
  add('p3', 'Check-F', 1, Math.min(1300, L - 30), 20);
  add('p4', 'Check-R', -1, Math.min(1326, L - 30), 20, '', [17]);
  if (circular) add('p5', 'Origin-F', 1, L - 9, 20);
  return { record: { ...record, primers: [...record.primers, ...primers] }, primerSites: sites };
}

// ---------------------------------------------------------------------------------------------
// Synthetic genome
// ---------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CODE = 'ACGT';
const COMPLEMENT_CODE: Record<number, number> = { 65: 84, 67: 71, 71: 67, 84: 65 };
const GENE_PREFIXES = ['yaa', 'ybb', 'ycc', 'ydd', 'yee', 'yff', 'ygg', 'yhh', 'yii', 'yjj', 'dna', 'rpo', 'fts', 'lac', 'ara', 'gal', 'trp', 'his', 'leu', 'thr'];

let genomeCache: { record: SeqRecord; enzymeSites: EnzymeSite[] } | null = null;

/** A 4,641,652 bp circular "E. coli-like" genome with ~4,500 features (CDS, promoters, terminators). */
export function syntheticGenome(): { record: SeqRecord; enzymeSites: EnzymeSite[] } {
  if (genomeCache) return genomeCache;
  const L = 4_641_652;
  const rand = mulberry32(42);
  const buf = new Uint8Array(L);
  for (let i = 0; i < L; i++) buf[i] = CODE.charCodeAt((rand() * 4) | 0);
  const features: Feature[] = [];
  let pos = 190;
  let n = 0;
  const writeCodon = (at: number, codon: string) => {
    for (let k = 0; k < 3; k++) buf[at + k] = codon.charCodeAt(k);
  };
  while (pos < L - 6000) {
    pos += 40 + Math.floor(rand() * 260);
    const codons = 90 + Math.floor(rand() * 640);
    const len = (codons + 2) * 3;
    const strand: 1 | -1 = rand() < 0.5 ? 1 : -1;
    // forward ORF in buf[pos, pos+len), then reverse-complemented in place for strand -1
    writeCodon(pos, 'ATG');
    for (let c = 1; c <= codons; c++) {
      let codon: string;
      do {
        codon = CODE[(rand() * 4) | 0] + CODE[(rand() * 4) | 0] + CODE[(rand() * 4) | 0];
      } while (STOPS.has(codon));
      writeCodon(pos + 3 * c, codon);
    }
    writeCodon(pos + 3 * (codons + 1), 'TAA');
    if (strand === -1) {
      for (let a = pos, b = pos + len - 1; a < b; a++, b--) {
        const x = COMPLEMENT_CODE[buf[a]];
        buf[a] = COMPLEMENT_CODE[buf[b]];
        buf[b] = x;
      }
    }
    n++;
    const name = `${GENE_PREFIXES[n % GENE_PREFIXES.length]}${String.fromCharCode(65 + (n % 26))}${n % 7 === 0 ? (n % 10).toString() : ''}`;
    features.push({
      id: `g${n}`,
      type: 'CDS',
      name,
      strand,
      segments: [{ start: pos, end: pos + len }],
      qualifiers: [
        { key: 'gene', value: name },
        { key: 'codon_start', value: '1' },
        { key: 'transl_table', value: '11' },
      ],
    });
    if (n % 3 === 0) {
      const pStart = strand === 1 ? Math.max(0, pos - 45) : pos + len + 5;
      features.push({
        id: `pr${n}`,
        type: 'promoter',
        name: `P${name}`,
        strand,
        segments: [{ start: pStart, end: pStart + 40 }],
        qualifiers: [],
      });
    }
    if (n % 5 === 0) {
      const tStart = strand === 1 ? pos + len + 8 : Math.max(0, pos - 38);
      features.push({
        id: `t${n}`,
        type: 'terminator',
        name: `${name} term`,
        strand,
        segments: [{ start: tStart, end: tStart + 30 }],
        qualifiers: [],
      });
    }
    pos += len;
  }
  const seq = new TextDecoder('ascii').decode(buf);
  const record: SeqRecord = {
    id: 'synthetic-genome',
    name: 'Synthetic genome',
    description: 'Synthetic 4.6 Mb bacterial chromosome (gallery performance test)',
    seq,
    topology: 'circular',
    molecule: 'DNA',
    features,
    primers: [],
    meta: {},
  };
  const enzymeSites = findDemoSites(seq, true, DEMO_ENZYMES.filter((e) => ['EcoRI', 'BamHI', 'NotI', 'XhoI'].includes(e.name)));
  genomeCache = { record, enzymeSites };
  return genomeCache;
}

// ---------------------------------------------------------------------------------------------
// Naive edits (demo only: the app uses the core insertBases / deleteRange / replaceRange)
// ---------------------------------------------------------------------------------------------

/** Remap a feature through "delete [at, at+removed), insert `inserted` bases at `at`" (null when nothing is left). */
function remapNaive(f: Feature, at: number, removed: number, inserted: number): Feature | null {
  const mapStart = (p: number) => (p < at ? p : p >= at + removed ? p - removed + inserted : at + inserted);
  const mapEnd = (p: number) => (p <= at ? p : p >= at + removed ? p - removed + inserted : at);
  const segments = f.segments
    .map((s) => ({ start: mapStart(s.start), end: mapEnd(s.end) }))
    .filter((s) => s.end > s.start);
  return segments.length ? { ...f, segments } : null;
}

/** Apply an edit with plain string operations (gap 0 / origin-wrapping edits on circular records follow the core). */
export function applyEditNaive(record: SeqRecord, edit: SequenceEdit): SeqRecord {
  const seq = record.seq;
  const L = seq.length;
  let at: number;
  let removed: number;
  let bases: string;
  if (edit.kind === 'insert') {
    at = record.topology === 'circular' && edit.gap === 0 ? L : edit.gap;
    removed = 0;
    bases = edit.bases;
  } else {
    at = edit.range.start;
    removed = edit.range.end - edit.range.start;
    bases = edit.kind === 'replace' ? edit.bases : '';
  }
  if (at + removed > L) {
    // wraps the origin: the replacement starts the new sequence, followed by the kept bases
    const tail = at + removed - L;
    const features = record.features.flatMap((f) => {
      const inside = f.segments.every((s) => s.start >= tail && s.end <= at);
      if (!inside) return [];
      return [{ ...f, segments: f.segments.map((s) => ({ start: s.start - tail + bases.length, end: s.end - tail + bases.length })) }];
    });
    return { ...record, seq: bases + seq.slice(tail, at), features };
  }
  const features = record.features
    .map((f) => remapNaive(f, at, removed, bases.length))
    .filter((f): f is Feature => f !== null);
  return { ...record, seq: seq.slice(0, at) + bases + seq.slice(at + removed), features };
}
